/** Render arbitrary frames of the RUN SF scene:  node scripts/still-run-sf.cjs 55 63 70 … */
const fs = require("fs"), os = require("os"), path = require("path");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderStill } = require("@remotion/renderer");
const ROOT = path.join(__dirname, "..");
const { scene, durationInFrames } = require("./build-run-sf-scene.cjs");
const OUT = path.join(ROOT, "data/run-sf/check");
const frames = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = path.join(ROOT, "remotion", "scenes");
  const tag = `_still_runsf_${Date.now().toString(36)}`;
  const sp = path.join(dir, `${tag}.tsx`), ep = path.join(dir, `${tag}.entry.tsx`);
  fs.writeFileSync(sp, scene);
  fs.writeFileSync(ep, `
import { registerRoot, Composition } from "remotion";
import React from "react";
import SceneInner from "./${tag}";
registerRoot(() => (<Composition id="Scene" component={SceneInner}
  durationInFrames={${durationInFrames}} fps={25} width={3840} height={2160} />));
`);
  try {
    const serveUrl = await bundle({ entryPoint: ep, publicDir: path.join(ROOT, "public") });
    const composition = await selectComposition({ serveUrl, id: "Scene" });
    for (const frame of frames) {
      const out = path.join(OUT, `f${String(frame).padStart(3, "0")}.png`);
      await renderStill({ composition, serveUrl, output: out, frame, scale: 0.25, imageFormat: "png" });
      console.log("rendered", frame, "->", out);
    }
  } finally {
    try { fs.unlinkSync(sp); } catch {}
    try { fs.unlinkSync(ep); } catch {}
  }
})();
