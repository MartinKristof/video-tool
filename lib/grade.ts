import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { resolveLutPath } from "./luts";

/**
 * Bake a colour-grade LUT into a copy of a source clip.
 *
 * Export has always applied a LUT as one ffmpeg `lut3d` pass over the finished
 * video (see lib/render-queue.ts), which grades the whole piece or nothing. To
 * grade ONE clip on a timeline, the grade has to live in the footage instead —
 * so this writes a derived file next to the source, exactly the way auto-reframe
 * does, and the clip simply points at it.
 *
 * Doing it this way means the grade shows in the preview and survives every
 * export path with no change to the renderer: by the time anything reads the
 * clip, it is just a different file.
 *
 * Derived outputs are `<base>.lut_<slug>.mp4` and are filtered out of media
 * listings so they never look like footage of their own.
 */

/** Escape an absolute path for use inside an ffmpeg filtergraph value. */
function escapeForFiltergraph(p: string): string {
  return `'${p.replace(/\\/g, "\\\\").replace(/'/g, "'\\''")}'`;
}

/** Filename-safe form of a LUT id ("custom/my-look.cube" → "custom-my-look"). */
export function lutSlug(lutId: string): string {
  return lutId
    .replace(/\.cube$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function gradedPathFor(mediaPath: string, lutId: string): string {
  const dir = path.dirname(mediaPath);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  return path.join(dir, `${base}.lut_${lutSlug(lutId)}.mp4`);
}

/** True for a derived grade output, so media listings can skip it. */
export function isGradedFilename(name: string): boolean {
  return /\.lut_[a-z0-9-]+\.mp4$/i.test(name);
}

/**
 * Grade `mediaPath` with `lutId`, reusing the cached output when it already
 * exists and is newer than the source. Returns the absolute path of the graded
 * file. Throws when the LUT id does not resolve or ffmpeg fails.
 */
export async function gradeWithCache(mediaPath: string, lutId: string): Promise<string> {
  const lut = resolveLutPath(lutId);
  if (!lut) throw new Error(`Unknown LUT "${lutId}"`);
  if (!fs.existsSync(mediaPath)) throw new Error("Source file not found");

  const out = gradedPathFor(mediaPath, lutId);
  // Reuse only when the grade is at least as new as the source; a re-uploaded
  // clip under the same name must not keep an old look.
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(mediaPath).mtimeMs) {
    return out;
  }

  const tmp = `${out}.partial.mp4`;
  await new Promise<void>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y",
      "-i", mediaPath,
      "-vf", `lut3d=${escapeForFiltergraph(lut)}`,
      "-c:v", "libx264",
      "-crf", "18",
      "-preset", "medium",
      "-pix_fmt", "yuv420p",
      // Audio is untouched: a colour grade has no business re-encoding it.
      "-c:a", "copy",
      tmp,
    ]);
    let err = "";
    ff.stderr.on("data", (d) => { err += d.toString(); });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg grade failed: ${err.slice(-500).trim()}`));
    });
  });

  // Rename only on success, so an interrupted run never leaves a half file that
  // the cache check above would then trust.
  fs.renameSync(tmp, out);
  return out;
}
