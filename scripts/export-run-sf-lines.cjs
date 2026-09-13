/**
 * Export each RUN SF line as its own transparent 4K clip.
 *
 *   node scripts/export-run-sf-lines.cjs ["/path/to/output/dir"]
 *
 * ProRes 4444 + yuva444p10le — the same alpha path the app's export dialog uses
 * (lib/render-queue.ts), spawned through the Remotion CLI so remotion.config.ts and
 * the company licence key apply. Clips are silent: the voice-over is already in the
 * Premiere timeline, and each file is trimmed to start exactly on its first word, so
 * dropping it at the timecode in its filename lines it up.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { makeScene, CUES, FPS, EXIT_FRAMES, tc } = require("./build-run-sf-scene.cjs");
const OUT_DIR = process.argv[2] || "/Volumes/T7 Shield/Run_SF_Promo/Graphics/Texts/Animated";
const WIDTH = 3840, HEIGHT = 2160;

const slug = (texts) => texts.join("-").replace(/[^A-Z0-9-]/gi, "");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let last = "";
    const onData = (b) => {
      const s = b.toString();
      const m = s.match(/(\d+)%|Rendered\s+(\d+)\/(\d+)/g);
      if (m) last = m[m.length - 1];
      process.stdout.write(`\r    ${last.padEnd(24)}`);
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => { process.stdout.write("\r"); code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)); });
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scenesDir = path.join(ROOT, "remotion", "scenes");
  const tag = `_runsf_${Date.now().toString(36)}`;
  const written = [];

  const lines = CUES.map((cue, i) => {
    const { source, durationInFrames } = makeScene({ onlyBlock: i, withAudio: false });
    const comp = `Line${i + 1}`;
    const file = path.join(scenesDir, `${tag}_${comp}.tsx`);
    fs.writeFileSync(file, source);
    written.push(file);
    const start = Math.min(...cue.frames);
    return {
      comp, durationInFrames, start,
      module: `./${path.basename(file, ".tsx")}`,
      out: path.join(OUT_DIR, `RUN-SF_${i + 1}_${slug(cue.texts)}_TC${tc(start).replace(/:/g, "-")}.mov`),
      texts: cue.texts,
    };
  });

  const entryPath = path.join(scenesDir, `${tag}.entry.tsx`);
  fs.writeFileSync(entryPath, `
import { registerRoot, Composition } from "remotion";
import React from "react";
${lines.map((l) => `import ${l.comp} from "${l.module}";`).join("\n")}
registerRoot(() => (
  <>
${lines.map((l) => `    <Composition id="${l.comp}" component={${l.comp}} durationInFrames={${l.durationInFrames}} fps={${FPS}} width={${WIDTH}} height={${HEIGHT}} />`).join("\n")}
  </>
));
`);
  written.push(entryPath);

  try {
    for (const l of lines) {
      console.log(`\n${l.comp}: ${l.texts.join(" ")}  (${l.durationInFrames} frames, place at ${tc(l.start)})`);
      await run("npx", [
        "remotion", "render", entryPath, l.comp, l.out,
        "--codec", "prores", "--prores-profile", "4444",
        "--image-format", "png", "--pixel-format", "yuva444p10le",
        "--log", "error",
      ]);
      const mb = (fs.statSync(l.out).size / 1024 / 1024).toFixed(1);
      console.log(`    -> ${path.basename(l.out)}  (${mb} MB)`);
    }
    console.log(`\nAll ${lines.length} lines exported to ${OUT_DIR}`);
    fs.writeFileSync(path.join(ROOT, "data/run-sf/exports.json"), JSON.stringify(
      lines.map((l) => ({ comp: l.comp, file: l.out, startFrame: l.start, timecode: tc(l.start),
                          durationInFrames: l.durationInFrames, words: l.texts })), null, 2));
  } finally {
    for (const f of written) { try { fs.unlinkSync(f); } catch {} }
  }
})();
