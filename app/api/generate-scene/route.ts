import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "@/lib/prompts";
import type { AnimationType, ProjectSettings, StyleMode, TransitionStyle } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 900;

const anthropic = new Anthropic();

/**
 * Write ONE animation and hand back its code.
 *
 * /api/generate is a conversation that owns a project's single scene file. This
 * is the other shape: a one-shot ask that returns a block to drop on a track, so
 * a timeline can gain an animation without the chat taking over the project.
 * Same system prompt, so the house style, the motion bans and the brand rules
 * are identical — only the plumbing differs.
 */

/** Pull the last fenced code block out of a reply. */
function extractCode(text: string): string | null {
  const matches = [...text.matchAll(/```(?:tsx|jsx|typescript|ts)?\n([\s\S]*?)```/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1][1].trim();
  return last.length > 50 ? last : null;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Turn a data: URI into an Anthropic image block, or null if it isn't a usable image. */
function imageBlock(dataUri: string): Anthropic.ImageBlockParam | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUri.trim());
  if (!m) return null;
  const mediaType = m[1].toLowerCase();
  if (!IMAGE_TYPES.has(mediaType)) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType as "image/png", data: m[2] },
  };
}

export async function POST(request: Request) {
  const body = await request.json();
  const {
    prompt,
    projectSettings,
    animationType = "animation",
    styleMode,
    transitionStyle,
    images = [],
  } = body as {
    prompt?: string;
    projectSettings?: ProjectSettings;
    animationType?: AnimationType;
    styleMode?: StyleMode;
    transitionStyle?: TransitionStyle;
    images?: string[];
  };

  if (!prompt || !prompt.trim()) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }
  if (!projectSettings) {
    return Response.json({ error: "projectSettings is required" }, { status: 400 });
  }

  const system = buildSystemPrompt(
    animationType,
    projectSettings,
    undefined,
    undefined,
    styleMode,
    undefined,
    false,
    undefined,
    transitionStyle,
  );

  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const uri of images.slice(0, 8)) {
    const block = imageBlock(uri);
    if (block) blocks.push(block);
  }
  blocks.push({
    type: "text",
    text:
      `${prompt.trim()}\n\n` +
      "Write this as ONE self-contained scene that will be placed as a block on an " +
      "existing timeline, so it has to stand on its own: open on its first frame with " +
      "the motion already underway, and finish cleanly rather than trailing off. " +
      "Reply with the complete file in a single tsx code block and nothing else." +
      (blocks.length ? " The attached images are the reference for what it should look like." : ""),
  });

  try {
    // Streamed and collected rather than a plain create: the SDK refuses a
    // non-streaming request at this token budget, because one could outlast the
    // 10-minute request ceiling. Nothing here needs the tokens as they arrive.
    const stream = anthropic.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: 32000,
      system,
      messages: [{ role: "user", content: blocks }],
    });
    const message = await stream.finalMessage();

    const text = message.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");
    const code = extractCode(text);
    if (!code) {
      return Response.json({ error: "The model didn't return a scene. Try describing it differently." }, { status: 502 });
    }
    return Response.json({ code });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Generation failed" },
      { status: 500 },
    );
  }
}
