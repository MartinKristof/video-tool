/**
 * Export the RUN SF "GET READY TO RUN" card as a transparent 4K clip.
 *
 *   node scripts/export-run-ready.cjs ["/path/to/output/dir"]
 *
 * ProRes 4444 + yuva444p10le — the same alpha path the app's export dialog uses
 * (lib/render-queue.ts), spawned through the Remotion CLI so remotion.config.ts and
 * the company licence key apply. The file starts exactly on the first cue, so
 * dropping it at the timecode in its name puts every word on Filip's frames.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { scene, durationInFrames, START, TC, CUE, EXITS, FPS, EXIT_FRAMES, tc } = require("./build-run-ready-scene.cjs");
const OUT_DIR = process.argv[2] || "/Volumes/T7 Shield/Run_SF_Promo/Graphics/Texts/Animated";
const W = 3840, H = 2160;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env });
    const onData = (b) => {
      const m = b.toString().match(/(\d+)%|Rendered\s+\d+\/\d+/g);
      if (m) process.stdout.write(`\r    ${m[m.length - 1].padEnd(22)}`);
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (c) => { process.stdout.write("\r"); c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`)); });
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scenesDir = path.join(ROOT, "remotion", "scenes");
  const tag = `_ready_${Date.now().toString(36)}`;
  const sp = path.join(scenesDir, `${tag}.tsx`);
  const ep = path.join(scenesDir, `${tag}.entry.tsx`);
  const out = path.join(OUT_DIR, `RUN-SF_GET-READY-TO-RUN_TC${TC.GET.replace(/:/g, "-")}.mov`);

  fs.writeFileSync(sp, scene);
  fs.writeFileSync(ep, `
import { registerRoot, Composition } from "remotion";
import React from "react";
import Scene from "./${tag}";
registerRoot(() => (<Composition id="Ready" component={Scene}
  durationInFrames={${durationInFrames}} fps={${FPS}} width={${W}} height={${H}} />));
`);

  try {
    console.log(`RUN SF get ready to run — ${durationInFrames} frames (${(durationInFrames / FPS).toFixed(2)}s)`);
    console.log(`place at ${TC.GET}, runs to ${tc(START + durationInFrames)}`);
    await run("npx", [
      "remotion", "render", ep, "Ready", out,
      "--codec", "prores", "--prores-profile", "4444",
      "--image-format", "png", "--pixel-format", "yuva444p10le",
      // public/ holds multi-GB renders and the bundler copies it wholesale; this
      // scene inlines its geometry and uses no staticFile(), so point it somewhere tiny.
      "--public-dir", path.join(ROOT, "public/assets/run-ready"),
      "--log", "error",
    ]);
    console.log(`    -> ${path.basename(out)}  (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
    fs.writeFileSync(path.join(ROOT, "data/run-ready/export.json"), JSON.stringify({
      file: out,
      startFrame: START,
      timecode: TC.GET,
      durationInFrames,
      words: ["GET", "READY", "TO", "RUN"].map((t, i) => ({
        text: t, in: TC[t], inFrame: CUE[t], outFrame: EXITS[i], goneFrame: EXITS[i] + EXIT_FRAMES,
      })),
      clears: { from: TC.exitStart, to: TC.exitEnd },
    }, null, 2));
  } finally {
    try { fs.unlinkSync(sp); } catch {}
    try { fs.unlinkSync(ep); } catch {}
  }
})();
