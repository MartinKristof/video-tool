import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { buildSystemPrompt, buildUserMessage } from "@/lib/prompts";
import { listSfx } from "@/lib/sfx";
import { getApifyReferenceImages, APIFY_REFERENCE_INTRO, framesToContentBlocks } from "@/lib/prompts/reference-images";
import { renderSampleFrames, sampleFrameNumbers } from "@/lib/render-queue";
import { listAssetPaths } from "@/lib/assets";
import { getProject } from "@/lib/projects";
import { buildEnrichedMediaFiles, type EnrichedMediaFile } from "@/lib/media-analysis";
import { isReframedFilename } from "@/lib/reframe";
import { getProjectSize } from "@/lib/types";
import { analyzeSvgs, manifestForPrompt, diffForPrompt } from "@/lib/svg-analyzer";
import { parseTape } from "@/lib/tape-parser";
import type { AnimationType, Engine, ProjectSettings, ChatMessage, SvgFile, StyleMode, TopicCardStyle, TransitionStyle } from "@/lib/types";

const anthropic = new Anthropic();

export const maxDuration = 300;

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function getMediaFileType(ext: string): "video" | "audio" | "image" | "other" {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "other";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function listMediaFiles(dir: string, baseDir: string): { name: string; path: string; type: string; sizeFormatted: string }[] {
  const files: { name: string; path: string; type: string; sizeFormatted: string }[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMediaFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      // Skip derived auto-reframe outputs — they're not user uploads.
      if (isReframedFilename(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const type = getMediaFileType(ext);
      if (type === "other") continue;
      const stat = fs.statSync(fullPath);
      files.push({
        name: entry.name,
        path: path.relative(baseDir, fullPath),
        type,
        sizeFormatted: formatSize(stat.size),
      });
    }
  }
  return files;
}

// Pull the LAST fenced code block out of streamed assistant text — this is the
// candidate scene the model wants rendered when it calls render_frames.
function extractLastCodeBlock(text: string): string | null {
  const matches = [...text.matchAll(/```(?:tsx|jsx|typescript|ts)?\n([\s\S]*?)```/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1][1];
  return last.trim().length > 50 ? last : null;
}

// Read the full source of a branded example scene or a helper library so the
// model can look up how something is really implemented (like grepping the repo).
function readSnippetSource(name: string): string {
  const clean = path.basename(name).replace(/\.(tsx?|jsx?)$/i, "");
  const candidates: string[] = [];
  const lower = clean.toLowerCase();
  if (lower === "motion") candidates.push(path.join(process.cwd(), "remotion", "motion.ts"));
  else if (lower === "decor") candidates.push(path.join(process.cwd(), "remotion", "decor.tsx"));
  else if (lower === "transitions") candidates.push(path.join(process.cwd(), "remotion", "transitions.tsx"));
  else candidates.push(path.join(process.cwd(), "remotion", "scenes", "branded", `${clean}.tsx`));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf-8");
    } catch { /* fall through */ }
  }
  const available = fs
    .readdirSync(path.join(process.cwd(), "remotion", "scenes", "branded"))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => f.replace(/\.tsx$/, ""));
  return `No snippet named "${name}". Available branded scenes: ${available.join(", ")}. Helper libraries: motion, decor, transitions.`;
}

// Regex-extract the declared duration/fps so we can render sample frames without
// evaluating the scene server-side. Falls back to sensible defaults for scenes
// whose durationInFrames is a computed expression.
function extractSceneMeta(code: string, fallbackFps: number): { durationInFrames: number; fps: number } {
  const dur = code.match(/export\s+const\s+durationInFrames\s*=\s*(\d+)/);
  const f = code.match(/export\s+const\s+fps\s*=\s*(\d+)/);
  return {
    durationInFrames: dur ? parseInt(dur[1], 10) : 250,
    fps: f ? parseInt(f[1], 10) : fallbackFps,
  };
}

// Tools the model drives itself — the render→look→fix loop, exactly how a coding
// agent works: write the scene, render a few frames, SEE it, fix what's wrong.
const AGENTIC_TOOLS: Anthropic.Tool[] = [
  {
    name: "render_frames",
    description:
      "Render a few still frames of the scene you just wrote so you can SEE how it actually looks, then fix any problems before finalizing. Write the COMPLETE scene as a ```tsx code block in the SAME message, then call this tool. Frames come back as images. Inspect them for: text overflow / clipping past the canvas edges, empty or frozen/dead frames, off-brand colour (background must read as near-black #161718 with a single orange accent — no other accent colours, no pure white/black), poor contrast or illegible text, everything-centred or broken layout, and pacing (content revealing too early or too late). If anything is wrong, return the COMPLETE corrected file in one ```tsx block. Use this once or twice for a substantial scene; skip it for a tiny edit.",
    input_schema: {
      type: "object",
      properties: {
        frames: {
          type: "array",
          items: { type: "integer" },
          description:
            "Optional specific frame numbers to render. Omit to auto-sample a spread across the whole duration.",
        },
      },
    },
  },
  {
    name: "read_snippet_source",
    description:
      "Read the full source of one of the branded example scenes (e.g. EndCard, LowerThird, ChartReveal, StatCallout) or a helper library (motion, decor, transitions) to see exactly how it's implemented before you use it. Like opening the real file in the codebase.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "A branded scene name (e.g. \"EndCard\") or a helper library: \"motion\", \"decor\", or \"transitions\".",
        },
      },
      required: ["name"],
    },
  },
];

// Extra system guidance appended when the render tool is available, so the model
// knows it can (and should) look at its own work.
const AGENTIC_GUIDANCE =
  "\n\n=== SELF-REVIEW (you can SEE your own output) ===\n" +
  "You have a `render_frames` tool that renders still frames of the scene you write and returns them as images. For any substantial scene, USE IT: write the complete scene, call render_frames, look at the frames, and fix any problems you see (overflow, empty/dead frames, off-brand colour, weak contrast, broken layout, bad timing). Then return the corrected complete file. One or two render passes is plenty — don't over-iterate. For a trivial edit you can skip rendering. You also have `read_snippet_source` to read the real source of any branded example or helper library when you need to see how something is done. Always end with the COMPLETE final scene in a single ```tsx block.";

export async function POST(request: Request) {
  const body = await request.json();
  const {
    messages,
    projectSettings,
    animationType,
    notionContent,
    scriptWithTimestamps,
    currentCode,
    svgContents,
    projectId,
    styleMode,
    topicCardStyle,
    transitionStyle,
    useSfx,
    engine,
  } = body as {
    messages: ChatMessage[];
    projectSettings: ProjectSettings;
    animationType: AnimationType;
    notionContent?: string;
    scriptWithTimestamps?: string;
    currentCode?: string;
    svgContents?: SvgFile[];
    projectId?: string;
    styleMode?: StyleMode;
    topicCardStyle?: TopicCardStyle;
    transitionStyle?: TransitionStyle;
    useSfx?: boolean;
    engine?: Engine;
  };

  if (!messages || !messages.length) {
    return Response.json({ error: "messages are required" }, { status: 400 });
  }

  const assetPaths = listAssetPaths();

  // For video projects, gather media file info enriched with analysis (probe +
  // transcript segments + scene cuts) so the AI can edit with real understanding
  // instead of just a filename list. Reads caches; only ffprobe may run inline.
  // The model only ever sees `notionContent` (injected as "REFERENCE CONTENT
  // (from Notion)"). Editing notes can land in the notes box (notionContent) OR
  // the prompt box (initialPrompt) — so for video, fall back to initialPrompt
  // when notionContent is empty, so the notes reach the model either way.
  let effectiveNotionContent = notionContent;
  let videoContext:
    | { projectId: string; mediaFiles: EnrichedMediaFile[]; compFps: number; topicCardStyle: TopicCardStyle }
    | undefined;
  if (animationType === "video" && projectId) {
    const project = getProject(projectId);
    if (!effectiveNotionContent?.trim() && project) {
      const init = project.initialPrompt?.trim();
      effectiveNotionContent =
        project.notionContent?.trim() ||
        (init && init !== "Edit uploaded footage" ? init : undefined);
    }
    if (project?.mediaFolder && fs.existsSync(project.mediaFolder)) {
      const mediaFiles = listMediaFiles(project.mediaFolder, project.mediaFolder);
      const target = getProjectSize(projectSettings);
      const enriched = await buildEnrichedMediaFiles(project, mediaFiles, target);
      videoContext = {
        projectId,
        mediaFiles: enriched,
        compFps: projectSettings.fps,
        topicCardStyle: topicCardStyle ?? project.topicCardStyle ?? "cards",
      };
    }
  }

  // For terminal projects, read the customTheme flag so the prompt can either
  // force the Apify default (when false/unset) or preserve the user's theme.
  // Also pre-compute the current tape duration server-side so the model can
  // do real math when the user says "extend" / "make it 10s" / etc.
  let customTheme: boolean | undefined;
  let currentTapeDurationMs: number | undefined;
  if (animationType === "terminal") {
    if (projectId) customTheme = getProject(projectId)?.customTheme;
    if (currentCode && currentCode.trim()) {
      currentTapeDurationMs = parseTape(currentCode).totalDurationMs;
    }
  }

  // SFX are only relevant for non-terminal compositions (terminal is VHS .tape).
  const sfx = animationType !== "terminal" ? listSfx() : [];
  const systemPrompt = buildSystemPrompt(animationType, projectSettings, assetPaths, videoContext, styleMode, customTheme, useSfx, sfx, engine, transitionStyle);

  // Attach Apify style reference images on the FIRST user turn only — keeps
  // follow-up edits cheap (the visual grammar is also encoded in the system prompt).
  const isTerminal = animationType === "terminal";
  const firstUserTurnIndex = messages.findIndex((m) => m.role === "user");
  const referenceImages = !isTerminal ? getApifyReferenceImages() : [];

  // Build Anthropic messages from chat history
  // Enhance the last user message with context
  const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg, i) => {
    const isLastUser = msg.role === "user" && i === messages.length - 1;
    const isFirstUser = msg.role === "user" && i === firstUserTurnIndex;
    const attachReferences = isFirstUser && referenceImages.length > 0;

    if (isLastUser) {
      let userContent = buildUserMessage(msg.content, currentCode, effectiveNotionContent, scriptWithTimestamps, animationType, currentTapeDurationMs, engine);
      if (svgContents && svgContents.length > 0) {
        const { manifests, sequenceDiff } = analyzeSvgs(svgContents);
        const parts: string[] = [];
        svgContents.forEach((svg, i) => {
          const m = manifests[i];
          if (m) {
            parts.push(
              `[SVG ${i + 1} MANIFEST]\n${JSON.stringify(manifestForPrompt(m), null, 2)}\n[END MANIFEST ${i + 1}]`
            );
          }
          parts.push(`[SVG ${i + 1}: ${svg.filename}]\n${svg.content}\n[END SVG ${i + 1}]`);
        });
        if (sequenceDiff) {
          parts.push(
            `[SEQUENCE DIFF — these SVGs share a viewBox and form a UI flow. Animate the deltas, not whole-frame crossfades.]\n${JSON.stringify(diffForPrompt(sequenceDiff), null, 2)}\n[END SEQUENCE DIFF]`
          );
        }
        userContent = `${parts.join("\n\n")}\n\n${userContent}`;
      }
      if (attachReferences) {
        return {
          role: "user" as const,
          content: [
            { type: "text", text: APIFY_REFERENCE_INTRO },
            ...referenceImages,
            { type: "text", text: userContent },
          ],
        };
      }
      return { role: "user" as const, content: userContent };
    }
    if (attachReferences) {
      return {
        role: "user" as const,
        content: [
          { type: "text", text: APIFY_REFERENCE_INTRO },
          ...referenceImages,
          { type: "text", text: msg.content },
        ],
      };
    }
    return {
      role: msg.role as "user" | "assistant",
      content: msg.content,
    };
  });

  // Enable the render→look→fix tool loop for standard Remotion scenes only:
  // not terminal .tape, not the HTML/GSAP hyperframes engine, and not
  // footage-overlay video projects (those can't be still-rendered from code
  // alone in this path). When enabled, the model drives its own vision loop.
  const toolsEnabled = !isTerminal && engine !== "hyperframes" && animationType !== "video";
  const { width: renderWidth, height: renderHeight } = getProjectSize(projectSettings);

  // Cache the big (~25K-token) system prompt so follow-up edits, error retries,
  // and every render→fix round re-pay ~0.1x on it instead of full price. The
  // dynamic tail (asset list / SFX / agentic guidance) is stable within a
  // session, so the cached prefix holds. Opus 4.8 caches a >=4096-token prefix.
  const systemText = toolsEnabled ? systemPrompt + AGENTIC_GUIDANCE : systemPrompt;
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
  ];

  // Hard safety caps so a model-driven loop can never run away or exceed the
  // 300s route budget: at most a few tool rounds and a few renders per request.
  const MAX_TOOL_TURNS = 3;
  const MAX_RENDERS = 4;

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        // The agentic loop: stream a turn and forward its text; if the model
        // asked to use tools (render_frames / read_snippet_source), run them
        // server-side, feed the results back, and repeat — until the model
        // produces a final answer or we hit the safety caps. Terminal projects
        // use cheap Sonnet with no tools and simply run one turn.
        const messages: Anthropic.MessageParam[] = [...anthropicMessages];
        let latestCode: string | null = currentCode ?? null;
        let toolTurns = 0;
        let renderCount = 0;
        let lastStopReason: string | null = null;
        const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

        for (;;) {
          const forceFinal = toolTurns >= MAX_TOOL_TURNS || renderCount >= MAX_RENDERS;
          const stream = isTerminal
            ? anthropic.messages.stream({
                model: "claude-sonnet-4-6",
                max_tokens: 32000,
                system: systemBlocks,
                messages,
              })
            : anthropic.messages.stream({
                model: "claude-opus-4-8",
                max_tokens: 64000,
                thinking: { type: "adaptive" },
                output_config: { effort: "high" },
                system: systemBlocks,
                messages,
                ...(toolsEnabled
                  ? { tools: AGENTIC_TOOLS, tool_choice: forceFinal ? { type: "none" as const } : { type: "auto" as const } }
                  : {}),
              });

          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              send({ text: event.delta.text });
            }
          }
          const finalMessage = await stream.finalMessage();
          const u = finalMessage.usage;
          usage.input += u.input_tokens;
          usage.cacheRead += u.cache_read_input_tokens ?? 0;
          usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
          usage.output += u.output_tokens;
          lastStopReason = finalMessage.stop_reason;

          // Track the latest scene code the model wrote — that's what
          // render_frames renders.
          const turnText = finalMessage.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const codeInTurn = extractLastCodeBlock(turnText);
          if (codeInTurn) latestCode = codeInTurn;

          if (finalMessage.stop_reason !== "tool_use") break;

          // Preserve the assistant turn verbatim (thinking + tool_use blocks
          // must be echoed back unchanged when continuing on the same model).
          messages.push({ role: "assistant", content: finalMessage.content });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of finalMessage.content) {
            if (block.type !== "tool_use") continue;
            if (block.name === "render_frames") {
              renderCount++;
              const framesArg = (block.input as { frames?: number[] } | null)?.frames;
              if (!latestCode) {
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content:
                    "No scene code found yet. Write the COMPLETE scene as a ```tsx block in your message, then call render_frames.",
                });
                continue;
              }
              const meta = extractSceneMeta(latestCode, projectSettings.fps);
              const frames = framesArg?.length ? framesArg : sampleFrameNumbers(meta.durationInFrames);
              try {
                const sampled = await renderSampleFrames(
                  projectId ?? "preview",
                  latestCode,
                  meta.durationInFrames,
                  meta.fps,
                  renderWidth,
                  renderHeight,
                  frames,
                  svgContents?.map((s) => ({ filename: s.filename, content: s.content })),
                );
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: [
                    {
                      type: "text",
                      text: "Rendered frames of your current scene — review them for overflow, empty/dead frames, off-brand colour, weak contrast, broken layout, and pacing, then return the complete corrected file (or confirm it looks clean).",
                    },
                    ...framesToContentBlocks(sampled, meta.durationInFrames),
                  ],
                });
              } catch (e) {
                const msg = e instanceof Error ? e.message : "render failed";
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content: `Render failed: ${msg.slice(-400)}. This usually means the scene has a compile or runtime error — fix it and return the corrected complete file.`,
                });
              }
            } else if (block.name === "read_snippet_source") {
              const name = String((block.input as { name?: string } | null)?.name ?? "");
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: readSnippetSource(name),
              });
            } else {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                is_error: true,
                content: `Unknown tool: ${block.name}`,
              });
            }
          }
          messages.push({ role: "user", content: toolResults });
          toolTurns++;
        }

        console.log(
          `[generate] agentic turns=${toolTurns} renders=${renderCount} stop=${lastStopReason} usage: in=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} out=${usage.output}`,
        );
        send({ done: true, stopReason: lastStopReason });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ error: message });
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
