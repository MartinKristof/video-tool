import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getProject } from "@/lib/projects";

export const maxDuration = 600;

/** Thumbnails across the whole file, tiled into one image. */
export const FILMSTRIP_TILES = 60;
export const FILMSTRIP_HEIGHT = 48;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exited ${code}`))));
  });
}

/**
 * A filmstrip for a video clip: evenly spaced frames tiled into a single wide
 * JPEG, generated with ffmpeg and cached beside the media.
 *
 * One image rather than N thumbnails on purpose — the timeline can then show it
 * as a CSS background and window it to whatever part of the source a clip is
 * trimmed to, with no per-frame requests and nothing decoded in the browser.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const file = new URL(request.url).searchParams.get("file");
  if (!file) return Response.json({ error: "file is required" }, { status: 400 });

  const project = getProject(projectId);
  if (!project?.mediaFolder) return Response.json({ error: "No media folder" }, { status: 404 });

  const mediaPath = path.resolve(project.mediaFolder, file);
  if (!mediaPath.startsWith(path.resolve(project.mediaFolder))) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }
  if (!fs.existsSync(mediaPath)) return Response.json({ error: "Not found" }, { status: 404 });

  const stripPath = `${mediaPath.replace(/\.[^.]+$/, "")}.strip.jpg`;

  if (!fs.existsSync(stripPath)) {
    try {
      // Prefer the duration already probed during analyze; fall back to ffprobe.
      let duration = 0;
      const probePath = `${mediaPath.replace(/\.[^.]+$/, "")}.probe.json`;
      if (fs.existsSync(probePath)) {
        try { duration = JSON.parse(fs.readFileSync(probePath, "utf-8")).duration ?? 0; } catch {}
      }
      if (!duration) {
        const out = await run("ffprobe", [
          "-v", "error", "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1", mediaPath,
        ]);
        duration = parseFloat(out.trim());
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        return Response.json({ error: "Could not read duration" }, { status: 500 });
      }

      const rate = FILMSTRIP_TILES / duration;
      // Two things make this fast enough to be worth doing at all:
      //
      //  -skip_frame nokey  decodes only keyframes, which is all a 48px-tall
      //                     thumbnail can show anyway.
      //  -hwaccel videotoolbox  hands 4K HEVC to the Apple media engine. On this
      //                     footage that is the difference between 50s and 5s,
      //                     for a byte-identical result.
      //
      // videotoolbox only exists on macOS, so a failure falls back to software
      // rather than leaving the timeline without filmstrips.
      const filters = `scale=-1:${FILMSTRIP_HEIGHT},fps=${rate},tile=${FILMSTRIP_TILES}x1`;
      const args = (hw: boolean) => [
        "-v", "fatal", "-y",
        ...(hw ? ["-hwaccel", "videotoolbox"] : []),
        "-skip_frame", "nokey", "-i", mediaPath, "-an",
        "-vf", filters, "-frames:v", "1", "-q:v", "6", stripPath,
      ];
      try {
        await run("ffmpeg", args(true));
      } catch {
        await run("ffmpeg", args(false));
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
    }
  }

  const body = fs.readFileSync(stripPath);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/jpeg",
      // Content is derived from an immutable source file; let the browser keep it.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
