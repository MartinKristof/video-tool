import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { getProject } from "@/lib/projects";
import { probeWithCache, readCachedProbe } from "@/lib/probe";
import { detectScenesWithCache, readCachedScenes } from "@/lib/scene-detect";
import { transcribeWithCache, readCachedTranscript } from "@/lib/transcribe";
import { reframeWithCache, isReframeAvailable, readCachedReframe } from "@/lib/reframe";
import { getProjectSize } from "@/lib/types";

// Analysis includes transcription, which is slow for long media. This value is a
// hint (self-hosted Next does not hard-enforce it). For very long interviews the
// client should treat the request as fire-and-forget and poll GET for status —
// the child processes keep running and cache their results even if the SSE
// connection drops.
export const maxDuration = 600;

interface PostBody {
  mediaFile: string; // relative path under project.mediaFolder
  model?: string;
  language?: string;
  sceneThreshold?: number;
  force?: boolean;
  // Auto-reframe: true = always, false = never, undefined = auto (only when the
  // source aspect differs from the project's timeline aspect).
  reframe?: boolean;
}

// Guard against two concurrent analyses of the same file — whisper writes an
// intermediate <base>.json that racing runs would clobber.
const inFlight = new Set<string>();

function resolveMediaPath(projectMediaFolder: string, mediaFile: string): string | null {
  const resolved = path.resolve(projectMediaFolder, mediaFile);
  if (!resolved.startsWith(path.resolve(projectMediaFolder))) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function sidecarPaths(mediaPath: string): string[] {
  const dir = path.dirname(mediaPath);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  return [
    path.join(dir, `${base}.probe.json`),
    path.join(dir, `${base}.scenes.json`),
    path.join(dir, `${base}.transcript.json`),
    path.join(dir, `${base}.reframe.json`),
  ];
}

function isVideoOrAudio(mediaPath: string): "video" | "audio" | "other" {
  const ext = path.extname(mediaPath).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a", ".aac"].includes(ext)) return "audio";
  return "other";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) return new Response("Project not found", { status: 404 });
  if (!project.mediaFolder) {
    return NextResponse.json({ error: "Project has no mediaFolder configured" }, { status: 400 });
  }

  const body = (await request.json()) as PostBody;
  if (!body.mediaFile) {
    return NextResponse.json({ error: "mediaFile is required" }, { status: 400 });
  }
  const mediaPath = resolveMediaPath(project.mediaFolder, body.mediaFile);
  if (!mediaPath) {
    return NextResponse.json(
      { error: `Media file not found or outside mediaFolder: ${body.mediaFile}` },
      { status: 404 }
    );
  }

  if (inFlight.has(mediaPath)) {
    return NextResponse.json(
      { error: "Analysis already in progress for this file" },
      { status: 409 }
    );
  }

  const kind = isVideoOrAudio(mediaPath);
  if (kind === "other") {
    return NextResponse.json({ error: "File is not video or audio" }, { status: 400 });
  }

  if (body.force) {
    await Promise.all(sidecarPaths(mediaPath).map((p) => fsp.unlink(p).catch(() => {})));
  }

  inFlight.add(mediaPath);
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true; // client went away — compute continues, caches still written
        }
      };

      try {
        // 1. Probe (fast).
        send({ stage: "probe", status: "start" });
        const probe = await probeWithCache(mediaPath);
        send({ stage: "probe", status: "done", probe });

        // 2. Scene cuts (video only; slow — decodes the file).
        if (kind === "video") {
          send({ stage: "scenes", status: "start" });
          const scenes = await detectScenesWithCache(mediaPath, {
            threshold: body.sceneThreshold,
            durationSeconds: probe.durationSeconds,
            onProgress: (fraction) =>
              send({ stage: "scenes", status: "progress", progress: fraction }),
          });
          send({ stage: "scenes", status: "done", cuts: scenes.cutsSeconds.length });
        }

        // 3. Transcript (slowest — Whisper).
        send({ stage: "transcript", status: "start" });
        const transcript = await transcribeWithCache(mediaPath, {
          model: body.model,
          language: body.language,
          onProgress: (line) => send({ stage: "transcript", status: "progress", line }),
        });
        send({
          stage: "transcript",
          status: "done",
          segments: transcript.segments?.length ?? 0,
          words: transcript.words.length,
        });

        // 4. Auto-reframe (video only). Auto when the source aspect differs from
        // the project's timeline aspect (e.g. 16:9 clip in a 9:16 project); can be
        // forced on/off via body.reframe. Best-effort — never fails the analysis.
        if (kind === "video") {
          const target = getProjectSize(project.settings);
          const srcAspect = probe.width && probe.height ? probe.width / probe.height : 0;
          const targetAspect = target.width / target.height;
          const mismatch = srcAspect > 0 && Math.abs(srcAspect - targetAspect) > 0.02;
          const shouldReframe = body.reframe === true || (body.reframe !== false && mismatch);
          if (shouldReframe && isReframeAvailable()) {
            send({ stage: "reframe", status: "start", target: [target.width, target.height] });
            try {
              const out = await reframeWithCache(mediaPath, {
                targetW: target.width,
                targetH: target.height,
                onProgress: (line) => send({ stage: "reframe", status: "progress", line: line.slice(-80) }),
              });
              send({ stage: "reframe", status: "done", output: out });
            } catch (e) {
              send({ stage: "reframe", status: "error", error: e instanceof Error ? e.message : "reframe failed" });
            }
          } else if (shouldReframe && !isReframeAvailable()) {
            send({ stage: "reframe", status: "unavailable" });
          }
        }

        send({ done: true });
        if (!closed) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      } catch (err) {
        send({ error: err instanceof Error ? err.message : "Analysis failed" });
        if (!closed) controller.close();
      } finally {
        inFlight.delete(mediaPath);
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

// Status endpoint — returns whatever is cached without recomputing, so the UI can
// poll a long-running analysis or show current state on load.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) return new Response("Project not found", { status: 404 });
  if (!project.mediaFolder) return NextResponse.json({ error: "No mediaFolder" }, { status: 400 });

  const mediaFile = request.nextUrl.searchParams.get("mediaFile");
  if (!mediaFile) {
    return NextResponse.json({ error: "mediaFile query param required" }, { status: 400 });
  }
  const mediaPath = resolveMediaPath(project.mediaFolder, mediaFile);
  if (!mediaPath) return NextResponse.json({ error: "Media file not found" }, { status: 404 });

  const kind = isVideoOrAudio(mediaPath);
  const target = getProjectSize(project.settings);
  const [probe, scenes, transcript, reframed] = await Promise.all([
    readCachedProbe(mediaPath),
    readCachedScenes(mediaPath),
    readCachedTranscript(mediaPath),
    kind === "video" ? readCachedReframe(mediaPath, target.width, target.height) : Promise.resolve(null),
  ]);

  const needsScenes = kind === "video" && !scenes;
  const analysisPending = !transcript || needsScenes;

  return NextResponse.json({
    inProgress: inFlight.has(mediaPath),
    analysisPending,
    probe,
    scenes,
    reframed,
    transcript: transcript
      ? {
          language: transcript.language,
          durationSeconds: transcript.durationSeconds,
          model: transcript.model,
          segments: transcript.segments?.length ?? 0,
          words: transcript.words.length,
        }
      : null,
  });
}
