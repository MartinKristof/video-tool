/** Render arbitrary frames of the lockup:  node scripts/still-run-lockup.cjs 48 52 56 … */
const fs = require("fs"), path = require("path");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderStill } = require("@remotion/renderer");
const ROOT = path.join(__dirname, "..");
const { scene, durationInFrames } = require("./build-run-lockup-scene.cjs");
const OUT = path.join(ROOT, "data/run-lockup/check");
const frames = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = path.join(ROOT, "remotion", "scenes");
  const tag = `_still_lockup_${Date.now().toString(36)}`;
  const sp = path.join(dir, `${tag}.tsx`), ep = path.join(dir, `${tag}.entry.tsx`);
  fs.writeFileSync(sp, scene);
  fs.writeFileSync(ep, `
import { registerRoot, Composition } from "remotion";
import React from "react";
import Scene from "./${tag}";
registerRoot(() => (<Composition id="Lockup" component={Scene}
  durationInFrames={${durationInFrames}} fps={25} width={3840} height={2160} />));
`);
  try {
    const serveUrl = await bundle({ entryPoint: ep, publicDir: path.join(ROOT, "public/assets/run-lockup") });
    const composition = await selectComposition({ serveUrl, id: "Lockup" });
    for (const frame of frames) {
      await renderStill({ composition, serveUrl, output: path.join(OUT, `f${String(frame).padStart(3, "0")}.png`), frame, imageFormat: "png" });
      process.stdout.write(`\rrendered ${frame}  `);
    }
    console.log();
  } finally { try { fs.unlinkSync(sp); } catch {} try { fs.unlinkSync(ep); } catch {} }
})();
