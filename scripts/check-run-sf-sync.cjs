/**
 * Frame-accuracy check for the RUN SF word-sync scene.
 *
 * For every word: render the frame BEFORE its onset and the onset frame itself,
 * and count orange (#F86606) pixels. The count must be flat across the pair for a
 * word that has not arrived yet, and must jump on the onset frame. This proves the
 * word lands on the intended frame without anyone squinting at a preview.
 *
 *   node scripts/check-run-sf-sync.cjs [outDir]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderStill } = require("@remotion/renderer");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(ROOT, "data/run-sf/check");
const { scene, durationInFrames } = require("./build-run-sf-scene.cjs");
const timing = JSON.parse(fs.readFileSync(path.join(ROOT, "data/run-sf/word-timings.json"), "utf8"));

const WIDTH = 3840, HEIGHT = 2160, FPS = 25;

function orangePixels(file) {
  // decode via ffmpeg rather than adding a PNG dependency
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1 << 28 });
  let n = 0;
  for (let i = 0; i < buf.length; i += 3) {
    if (buf[i] > 150 && buf[i + 1] > 40 && buf[i + 1] < 150 && buf[i + 2] < 80) n++;  // the #F86606 family
  }
  return n;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scenesDir = path.join(ROOT, "remotion", "scenes");
  const tag = `_check_runsf_${Date.now().toString(36)}`;
  const scenePath = path.join(scenesDir, `${tag}.tsx`);
  const entryPath = path.join(scenesDir, `${tag}.entry.tsx`);

  fs.writeFileSync(scenePath, scene, "utf-8");
  fs.writeFileSync(entryPath, `
import { registerRoot, Composition } from "remotion";
import React from "react";
import SceneInner from "./${tag}";
registerRoot(() => (
  <Composition id="Scene" component={SceneInner}
    durationInFrames={${durationInFrames}} fps={${FPS}} width={${WIDTH}} height={${HEIGHT}} />
));
`, "utf-8");

  try {
    console.log("bundling…");
    const serveUrl = await bundle({ entryPoint: entryPath, publicDir: path.join(ROOT, "public") });
    const composition = await selectComposition({ serveUrl, id: "Scene" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runsf-check-"));

    const wanted = new Set();
    for (const w of timing.words) { wanted.add(w.frame - 2); wanted.add(w.frame - 1); wanted.add(w.frame); }
    const frames = [...wanted].filter((f) => f >= 0).sort((a, b) => a - b);

    const counts = {};
    for (const frame of frames) {
      const p = path.join(tmp, `f${frame}.png`);
      await renderStill({ composition, serveUrl, output: p, frame, scale: 0.25, imageFormat: "png" });
      counts[frame] = orangePixels(p);
      fs.renameSync(p, path.join(OUT, `f${String(frame).padStart(3, "0")}.png`));
    }

    console.log(`\n${"word".padEnd(12)}${"frame".padStart(6)}${"px@f-2".padStart(9)}${"px@f-1".padStart(9)}${"px@f".padStart(9)}${"  verdict"}`);
    let bad = 0;
    for (const w of timing.words) {
      const f = w.frame;
      const a = counts[f - 2], b = counts[f - 1], c = counts[f];
      // before the onset the word must not be drawing; on the onset it must appear
      const quietBefore = a === undefined || b === undefined || Math.abs(b - a) <= Math.max(30, a * 0.02);
      const jumpsOn = c > b + 30;
      const ok = quietBefore && jumpsOn;
      if (!ok) bad++;
      console.log(
        `${w.text.padEnd(12)}${String(f).padStart(6)}` +
        `${String(a ?? "-").padStart(9)}${String(b ?? "-").padStart(9)}${String(c ?? "-").padStart(9)}` +
        `  ${ok ? "OK" : (!jumpsOn ? "FAIL: no arrival on its frame" : "FAIL: already moving before onset")}`
      );
    }
    console.log(`\n${timing.words.length - bad}/${timing.words.length} words land exactly on their frame`);
    console.log(`stills: ${OUT}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = bad ? 1 : 0;   // not process.exit(), so the cleanup below still runs
  } finally {
    try { fs.unlinkSync(scenePath); } catch {}
    try { fs.unlinkSync(entryPath); } catch {}
  }
})();
