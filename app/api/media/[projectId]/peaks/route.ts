import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getProject } from "@/lib/projects";

export const maxDuration = 600;

const BUCKETS = 1200;

/**
 * Downsampled audio peaks for drawing a waveform on a timeline clip.
 *
 * Decoding is done here with ffmpeg — which the render pipeline already depends
 * on — rather than in the browser: pulling a 4K interview through WebAudio just
 * to draw a few hundred pixels of waveform is exactly the kind of thing that
 * makes an editor feel slow. The result is cached beside the media as
 * `<name>.peaks.json`, the same convention as the probe and transcript caches.
 */
function computePeaks(mediaPath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    // Mono, 8 kHz, signed 16-bit — far more resolution than a waveform needs,
    // and small enough that a long interview decodes in a couple of seconds.
    const proc = spawn("ffmpeg", [
      "-v", "error", "-i", mediaPath,
      "-ac", "1", "-ar", "8000", "-f", "s16le", "-",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      const samples = Math.floor(pcm.length / 2);
      if (samples === 0) { resolve([]); return; }

      const per = Math.max(1, Math.floor(samples / BUCKETS));
      const peaks: number[] = [];
      for (let b = 0; b < BUCKETS; b++) {
        const start = b * per;
        if (start >= samples) break;
        const end = Math.min(samples, start + per);
        let max = 0;
        for (let i = start; i < end; i++) {
          const v = Math.abs(pcm.readInt16LE(i * 2));
          if (v > max) max = v;
        }
        peaks.push(Math.round((max / 32768) * 1000) / 1000);
      }
      resolve(peaks);
    });
  });
}

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

  const cachePath = `${mediaPath.replace(/\.[^.]+$/, "")}.peaks.json`;
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (Array.isArray(cached?.peaks)) return Response.json(cached);
    } catch {
      // fall through and regenerate
    }
  }

  try {
    const peaks = await computePeaks(mediaPath);
    const payload = { peaks, buckets: peaks.length };
    fs.writeFileSync(cachePath, JSON.stringify(payload), "utf-8");
    return Response.json(payload);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
