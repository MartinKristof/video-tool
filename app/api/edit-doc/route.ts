import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { EDITOR_AGENT_PROMPT } from "@/lib/prompts/editor-agent";
import { framesToContentBlocks } from "@/lib/prompts/reference-images";
import { renderSampleFrames, sampleFrameNumbers } from "@/lib/render-queue";
import { getProject } from "@/lib/projects";
import { sceneCodeFromDoc } from "@/lib/editor-render";
import { docDuration, isValidDoc, type AssetKind, type EditorDoc } from "@/lib/editor-doc";
import { applyDocTool, describeDoc, DOC_TOOLS, DOC_TOOL_NAMES, toolsWithSnippets, type AgentContext } from "@/lib/editor-agent";
import { loadSnippetCatalog } from "@/lib/snippet-catalog";
import { readCachedTranscript, transcribeWithCache, type TranscriptWord } from "@/lib/transcribe";
import { probeWithCache } from "@/lib/probe";
import type { ChatMessage } from "@/lib/types";

const anthropic = new Anthropic();

export const maxDuration = 300;

/**
 * The AI editing the timeline it can see.
 *
 * This is app/api/generate's agentic loop pointed at the document model instead
 * of at a TSX file: same SSE shape, same prompt caching, same safety caps. What
 * changes is what the model produces — not code, but tool calls onto the pure
 * functions in lib/editor-doc.ts. The document is mutated on a server-side
 * working copy and streamed back, so a broken turn can never leave a half-applied
 * edit on the client.
 *
 * `render_frames` is the reason this can be trusted: it renders the WORKING
 * document through the same `sceneCodeFromDoc` path the real export uses, so the
 * model looks at the actual cut before saying it is done.
 */

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);

function kindOf(ext: string): AssetKind | null {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === ".gif") return "gif";
  return null;
}

function walk(dir: string, base: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

/** The project's own footage, named the way the model will refer to it. */
async function listMedia(projectId: string, mediaFolder: string) {
  const files = walk(mediaFolder, mediaFolder);
  const out: NonNullable<AgentContext["mediaFiles"]> = [];
  for (const rel of files) {
    const kind = kindOf(path.extname(rel).toLowerCase());
    if (!kind) continue;
    let durationSec: number | undefined;
    let width: number | undefined;
    let height: number | undefined;
    try {
      const probe = await probeWithCache(path.join(mediaFolder, rel));
      durationSec = probe?.durationSeconds;
      width = probe?.width;
      height = probe?.height;
    } catch {
      // A file we can't probe is still placeable; the model just has to say how long.
    }
    out.push({
      file: rel,
      src: `/api/media/${projectId}/${rel.split(path.sep).map(encodeURIComponent).join("/")}`,
      kind,
      durationSec,
      width,
      height,
    });
  }
  return out;
}

/**
 * Resolve an asset's `src` back to a file on disk, so its transcript can be
 * found. Reuses the containment check from the captions route — `src` is client
 * data and must not be able to reach outside the project's own media folder.
 */
function assetPath(src: string, projectId: string, mediaFolder: string): string | null {
  const prefix = `/api/media/${projectId}/`;
  if (!src.startsWith(prefix)) return null;
  const rel = decodeURIComponent(src.slice(prefix.length));
  const resolved = path.resolve(mediaFolder, rel);
  if (!resolved.startsWith(path.resolve(mediaFolder))) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * Transcripts that are ALREADY cached, keyed by asset id.
 *
 * Only cached ones: transcribing is minutes of Whisper, and doing it eagerly
 * would burn the route's whole budget before the model had said anything. When
 * nothing is cached the model is told so and can call transcribe_clip, which
 * pays that cost deliberately and only for the clip it actually needs.
 */
async function cachedTranscripts(doc: EditorDoc, projectId: string, mediaFolder: string) {
  const out: Record<string, TranscriptWord[]> = {};
  for (const asset of doc.assets) {
    if (asset.kind !== "video" && asset.kind !== "audio") continue;
    const file = assetPath(asset.src, projectId, mediaFolder);
    if (!file) continue;
    const cached = await readCachedTranscript(file);
    if (cached?.words?.length) out[asset.id] = cached.words;
  }
  return out;
}

const TRANSCRIBE_TOOL: Anthropic.Tool = {
  name: "transcribe_clip",
  description:
    "Transcribe one video or audio clip so its words can be located on the timeline. Only needed when the outline says no transcript is available. It runs speech recognition locally and can take a while on a long file, so do it once for the clip you actually need, then use read_transcript or find_gaps.",
  input_schema: {
    type: "object",
    properties: { itemId: { type: "string", description: "The video or audio item to transcribe." } },
    required: ["itemId"],
  },
};

const RENDER_TOOL: Anthropic.Tool = {
  name: "render_frames",
  description:
    "Render still frames of the timeline AS IT STANDS RIGHT NOW and look at them. Use this after any visual change to check the result is legible, on screen, not clipped and not landing on an empty frame — then fix what you see. Frames come back as images.",
  input_schema: {
    type: "object",
    properties: {
      frames: {
        type: "array",
        items: { type: "integer" },
        description: "Specific frames to render. Omit to sample across the whole video.",
      },
    },
  },
};

const MAX_TOOL_TURNS = 8;
const MAX_OPS = 40;
const MAX_RENDERS = 2;

export async function POST(request: Request) {
  const body = await request.json();
  const {
    messages,
    doc: incomingDoc,
    projectId,
    selectedIds,
    playheadFrame,
  } = body as {
    messages: ChatMessage[];
    doc: EditorDoc;
    projectId?: string;
    selectedIds?: string[];
    playheadFrame?: number;
  };

  if (!messages?.length) return Response.json({ error: "messages are required" }, { status: 400 });
  if (!incomingDoc?.tracks) return Response.json({ error: "doc is required" }, { status: 400 });
  if (!isValidDoc(incomingDoc)) {
    return Response.json({ error: "The document is not in a valid state" }, { status: 400 });
  }

  const project = projectId ? getProject(projectId) : null;
  const mediaFolder = project?.mediaFolder && fs.existsSync(project.mediaFolder) ? project.mediaFolder : null;

  const ctx: AgentContext = {
    fps: incomingDoc.size.fps,
    playheadFrame,
    selectedIds,
    mediaFiles: mediaFolder && projectId ? await listMedia(projectId, mediaFolder) : [],
    transcripts: mediaFolder && projectId ? await cachedTranscripts(incomingDoc, projectId, mediaFolder) : {},
    // Read here rather than in editor-agent, which is pure by contract so every
    // failure mode stays testable with no fs and no network.
    snippets: loadSnippetCatalog(),
  };

  // The bundle server runs on its own port, so a root-relative "/api/media/..."
  // src would 404 against it. Same rewrite /api/render does.
  const origin = new URL(request.url).origin;

  const tools: Anthropic.Tool[] = toolsWithSnippets(
    [...DOC_TOOLS, RENDER_TOOL, ...(mediaFolder ? [TRANSCRIBE_TOOL] : [])],
    (ctx.snippets ?? []).map((sn) => sn.id),
  );

  // Cache the prompt + tool list. Everything volatile (the outline, the playhead,
  // the selection) goes in the LAST USER MESSAGE, never in the system block —
  // put it in the system prompt and the cache dies on every single turn.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: EDITOR_AGENT_PROMPT, cache_control: { type: "ephemeral" } },
  ];

  const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg, i) => {
    const isLastUser = msg.role === "user" && i === messages.length - 1;
    if (!isLastUser) return { role: msg.role, content: msg.content };
    return {
      role: "user",
      content: `${describeDoc(incomingDoc, ctx)}\n\n=== THE REQUEST ===\n${msg.content}`,
    };
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        let working = incomingDoc;
        const convo: Anthropic.MessageParam[] = [...anthropicMessages];
        let toolTurns = 0;
        let ops = 0;
        let renders = 0;
        let lastStopReason: string | null = null;
        // The model speaks across several turns, before and after each tool
        // round, and the pieces need joining carefully. Run them together raw and
        // a finished sentence collides with the next ("…that first clip.Here's
        // what's said"); break unconditionally and a turn that stopped MID-WORD to
        // call a tool comes back split ("Trimmed n" / "ine pauses"). So the break
        // goes in only where a sentence actually ended.
        let saidAnything = false;
        let needsBreak = false;
        let saidSinceTools = true;
        let lastChar = "";
        const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

        for (;;) {
          const forceFinal = toolTurns >= MAX_TOOL_TURNS || ops >= MAX_OPS;
          const stream = anthropic.messages.stream({
            model: "claude-opus-5",
            max_tokens: 32000,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
            system: systemBlocks,
            messages: convo,
            tools,
            tool_choice: forceFinal ? { type: "none" as const } : { type: "auto" as const },
          });

          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (needsBreak) {
                if (saidAnything && /[.!?:"')\]]$/.test(lastChar)) send({ text: "\n\n" });
                needsBreak = false;
              }
              saidAnything = true;
              saidSinceTools = true;
              const text = event.delta.text;
              if (text.trim()) lastChar = text.trimEnd().slice(-1);
              send({ text });
            }
          }
          const final = await stream.finalMessage();
          usage.input += final.usage.input_tokens;
          usage.cacheRead += final.usage.cache_read_input_tokens ?? 0;
          usage.cacheWrite += final.usage.cache_creation_input_tokens ?? 0;
          usage.output += final.usage.output_tokens;
          lastStopReason = final.stop_reason;

          if (final.stop_reason !== "tool_use") break;

          // Echo the assistant turn back verbatim — thinking and tool_use blocks
          // must survive unchanged when continuing on the same model.
          convo.push({ role: "assistant", content: final.content });

          const results: Anthropic.ToolResultBlockParam[] = [];
          let docChanged = false;

          for (const block of final.content) {
            if (block.type !== "tool_use") continue;

            if (block.name === "render_frames") {
              renders++;
              if (renders > MAX_RENDERS) {
                results.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: "You've already looked at this edit twice. Finish up and reply.",
                });
                continue;
              }
              const duration = docDuration(working);
              const wanted = (block.input as { frames?: number[] } | null)?.frames;
              const frames = wanted?.length ? wanted : sampleFrameNumbers(duration);
              try {
                const code = sceneCodeFromDoc(working).replace(
                  /(["'`])\/api\/media\//g,
                  `$1${origin}/api/media/`,
                );
                const sampled = await renderSampleFrames(
                  projectId ?? "editor",
                  code,
                  duration,
                  working.size.fps,
                  working.size.width,
                  working.size.height,
                  frames,
                );
                results.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: [
                    {
                      type: "text",
                      text: "The timeline as it stands. Check legibility, anything clipped or off screen, anything overlapping badly, and whether a frame is unintentionally empty — then fix what you see.",
                    },
                    ...framesToContentBlocks(sampled, duration),
                  ],
                });
              } catch (e) {
                const msg = e instanceof Error ? e.message : "render failed";
                results.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content: `Could not render: ${msg.slice(-400)}`,
                });
              }
              continue;
            }

            if (block.name === "transcribe_clip" && mediaFolder && projectId) {
              const itemId = (block.input as { itemId?: string } | null)?.itemId;
              const found = working.tracks
                .flatMap((t) => t.items)
                .find((i) => i.id === itemId);
              const asset =
                found && (found.type === "video" || found.type === "audio")
                  ? working.assets.find((x) => x.id === found.assetId)
                  : undefined;
              const file = asset ? assetPath(asset.src, projectId, mediaFolder) : null;
              if (!file) {
                results.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content: `Nothing transcribable called "${itemId}". Only video and audio items that came from this project's own footage can be transcribed.`,
                });
                continue;
              }
              try {
                const transcript = await transcribeWithCache(file);
                ctx.transcripts = { ...ctx.transcripts, [asset!.id]: transcript.words };
                results.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: `Transcribed ${asset!.name}: ${transcript.words.length} words. Now call read_transcript or find_gaps to place them on the timeline.`,
                });
              } catch (e) {
                results.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content: `Transcription failed: ${e instanceof Error ? e.message : "unknown error"}`,
                });
              }
              continue;
            }

            if (DOC_TOOL_NAMES.has(block.name)) {
              ops++;
              const outcome = applyDocTool(working, block.name, block.input, ctx);
              if (outcome.doc !== working) {
                working = outcome.doc;
                docChanged = true;
              }
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                ...(outcome.isError ? { is_error: true } : {}),
                content: outcome.result,
              });
              continue;
            }

            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `Unknown tool: ${block.name}`,
            });
          }

          // Show the edit landing while the model is still working. Sent as
          // transient so a turn of ten tool calls is still ONE undo step.
          if (docChanged) send({ doc: working, transient: true });

          convo.push({ role: "user", content: results });
          needsBreak = true;
          saidSinceTools = false;
          toolTurns++;
        }

        console.log(
          `[edit-doc] turns=${toolTurns} ops=${ops} renders=${renders} stop=${lastStopReason} usage: in=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} out=${usage.output}`,
        );

        // A turn that does the work and then says nothing leaves the user
        // staring at a changed timeline with no explanation. The prompt asks for
        // a closing line; this is the backstop for when it doesn't come.
        if (!saidSinceTools && working !== incomingDoc) {
          const was = docDuration(incomingDoc) / working.size.fps;
          const now = docDuration(working) / working.size.fps;
          send({
            text: `${saidAnything ? "\n\n" : ""}Done — the timeline is updated${
              Math.abs(now - was) > 0.05
                ? `, and now runs ${now.toFixed(1)}s (was ${was.toFixed(1)}s)`
                : ""
            }.`,
          });
        }

        // The commit: one undo step for the whole turn.
        if (working !== incomingDoc) send({ doc: working });
        send({ done: true, stopReason: lastStopReason, edited: working !== incomingDoc });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        send({ error: err instanceof Error ? err.message : "Unknown error" });
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
