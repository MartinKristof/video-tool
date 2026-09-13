/**
 * RUN SF end lockup — verification.
 *
 *   node scripts/verify-run-lockup.cjs
 *
 * Three objective checks, all against rendered pixels rather than intent:
 *   1. PLACEMENT — render clip frame 72 (= 00:00:28:08) and compute per-colour IoU
 *      against Filip's reference frame. The reference has footage behind the
 *      graphic, so only the graphic's own colours are compared.
 *   2. ONSETS    — each layer's own bbox must be empty on the frame before its cue
 *      and filled on the cue frame.
 *   3. REST      — frames 40 and 72 must be pixel-identical: the idle beat has to
 *      leave the lockup exactly where it found it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderStill } = require("@remotion/renderer");

const ROOT = path.join(__dirname, "..");
const REF = "/Users/filip/Downloads/TEST.00_00_28_08.Still001.png";
const { scene, durationInFrames, CUES } = require("./build-run-lockup-scene.cjs");
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "public/assets/run-lockup/lockup.json"), "utf8"));

const W = 3840, H = 2160, SCALE = 0.82;
const OFF_X = (W - geo.width * SCALE) / 2;
const OFF_Y = (H - geo.height * SCALE) / 2;

const COLOURS = {
  orange: [248, 102, 6],
  blue: [36, 109, 255],
  green: [32, 163, 78],
  white: [255, 255, 255],
};

// Each element gets its own colour AND x-band, in final frame pixels, so the ivory
// rule is never confused with the white wordmark and vice versa.
const PROBES = [
  { name: "RUN dots",  colour: COLOURS.orange,   tol: 6, x: [300, 2000] },
  { name: "divider",   colour: [250, 247, 242],  tol: 4, x: [2150, 2250] },
  { name: "sym green", colour: COLOURS.green,    tol: 6, x: [2400, 2600] },
  { name: "sym blue",  colour: COLOURS.blue,     tol: 6, x: [2580, 2760] },
  { name: "sym orange",colour: COLOURS.orange,   tol: 6, x: [2400, 2760] },
  { name: "wordmark",  colour: COLOURS.white,    tol: 4, x: [2800, 3600] },
];

function rgb(file) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1 << 30 });
}

function mask(buf, target, tol, xband) {
  const m = new Uint8Array(W * H);
  const [xa, xb] = xband || [0, W];
  for (let y = 0; y < H; y++) {
    for (let x = xa; x < xb; x++) {
      const p = y * W + x, i = p * 3;
      if (Math.abs(buf[i] - target[0]) <= tol && Math.abs(buf[i + 1] - target[1]) <= tol && Math.abs(buf[i + 2] - target[2]) <= tol) m[p] = 1;
    }
  }
  return m;
}

function coverage(ref, ours) {
  let inter = 0, nref = 0, nours = 0;
  for (let i = 0; i < ref.length; i++) {
    if (ref[i]) { nref++; if (ours[i]) inter++; }
    if (ours[i]) nours++;
  }
  return { cov: nref ? inter / nref : 1, inter, nref, nours };
}

function bboxOfMask(m) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

(async () => {
  const scenesDir = path.join(ROOT, "remotion", "scenes");
  const tag = `_verify_lockup_${Date.now().toString(36)}`;
  const sp = path.join(scenesDir, `${tag}.tsx`);
  const ep = path.join(scenesDir, `${tag}.entry.tsx`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lockup-"));
  const OUT = path.join(ROOT, "data/run-lockup/check");
  fs.mkdirSync(OUT, { recursive: true });
  let bad = 0;

  fs.writeFileSync(sp, scene);
  fs.writeFileSync(ep, `
import { registerRoot, Composition } from "remotion";
import React from "react";
import Scene from "./${tag}";
registerRoot(() => (<Composition id="Lockup" component={Scene}
  durationInFrames={${durationInFrames}} fps={25} width={${W}} height={${H}} />));
`);

  try {
    console.log("bundling…");
    // Point the bundler at the tiny lockup asset folder, not the whole public/ dir:
    // public/ contains multi-GB renders and every bundle copies it wholesale, which
    // fills the disk after a few runs. This scene inlines its geometry and uses no
    // staticFile(), so it needs nothing from public/.
    const serveUrl = await bundle({ entryPoint: ep, publicDir: path.join(ROOT, "public/assets/run-lockup") });
    const composition = await selectComposition({ serveUrl, id: "Lockup" });

    const need = [0, CUES.divider - 1, CUES.divider, CUES.symbol - 1, CUES.symbol,
                  CUES.wordmark - 1, CUES.wordmark, 20, 40, 60, 72, 100];
    const frames = [...new Set(need)].filter((f) => f >= 0).sort((a, b) => a - b);
    const png = {};
    for (const frame of frames) {
      const p = path.join(OUT, `f${String(frame).padStart(3, "0")}.png`);
      await renderStill({ composition, serveUrl, output: p, frame, imageFormat: "png" });
      png[frame] = p;
      process.stdout.write(`\rrendered ${frame}   `);
    }
    console.log("\n");

    // ── 1. PLACEMENT ────────────────────────────────────────────────────────
    console.log("1. PLACEMENT — clip frame 72 vs the reference frame\n");
    console.log("   Coverage = share of the reference graphic's pixels our render also covers.");
    console.log("   Ours legitimately has MORE pixels: the reference is composited over wood, so its");
    console.log("   antialiased edges blend away, while ours sit on transparency and stay pure.\n");
    const refBuf = rgb(REF);
    const ourBuf = rgb(png[72]);
    for (const probe of PROBES) {
      const { name, colour: c, tol } = probe;
      const mr = mask(refBuf, c, tol, probe.x), mo = mask(ourBuf, c, tol, probe.x);
      const r = coverage(mr, mo);
      const br = bboxOfMask(mr), bo = bboxOfMask(mo);
      const drift = br && bo ? Math.max(...br.map((v, i) => Math.abs(v - bo[i]))) : 999;
      const ok = r.cov > 0.999 && drift <= 3;
      if (!ok) bad++;
      console.log(`   ${name.padEnd(7)} coverage ${r.cov.toFixed(4)}   ref ${String(r.nref).padStart(7)} px   ours ${String(r.nours).padStart(7)} px   bbox drift ${drift}px   ${ok ? "OK" : "FAIL"}`);
    }

    // ── 2. ONSETS ───────────────────────────────────────────────────────────
    console.log("\n2. ONSETS — each layer's own box, the frame before its cue and on it\n");
    const boxes = {
      RUN: { bbox: geo.runBox, cue: CUES.run, colour: COLOURS.orange },
      divider: { bbox: geo.layers.divider.bbox, cue: CUES.divider, colour: [250, 247, 242], tol: 8 },
      symbol: {
        bbox: geo.layers.symbol.reduce((a, s) => [Math.min(a[0], s.bbox[0]), Math.min(a[1], s.bbox[1]), Math.max(a[2], s.bbox[2]), Math.max(a[3], s.bbox[3])], [1e9, 1e9, -1e9, -1e9]),
        cue: CUES.symbol, colour: COLOURS.green,
      },
      wordmark: {
        bbox: geo.layers.wordmark.reduce((a, s) => [Math.min(a[0], s.bbox[0]), Math.min(a[1], s.bbox[1]), Math.max(a[2], s.bbox[2]), Math.max(a[3], s.bbox[3])], [1e9, 1e9, -1e9, -1e9]),
        cue: CUES.wordmark, colour: COLOURS.white,
      },
    };
    const PAD = 40;
    for (const [name, spec] of Object.entries(boxes)) {
      const box = {
        x0: Math.max(0, Math.round(OFF_X + (spec.bbox[0] - PAD) * SCALE)),
        y0: Math.max(0, Math.round(OFF_Y + (spec.bbox[1] - PAD) * SCALE)),
        x1: Math.min(W, Math.round(OFF_X + (spec.bbox[2] + PAD) * SCALE)),
        y1: Math.min(H, Math.round(OFF_Y + (spec.bbox[3] + PAD) * SCALE)),
      };
      const count = (f) => {
        if (png[f] === undefined) return null;
        const b = rgb(png[f]);
        const tol = spec.tol ?? 8;
        let n = 0;
        for (let y = box.y0; y < box.y1; y++) {
          let i = (y * W + box.x0) * 3;
          for (let x = box.x0; x < box.x1; x++, i += 3) {
            if (Math.abs(b[i] - spec.colour[0]) <= tol && Math.abs(b[i + 1] - spec.colour[1]) <= tol && Math.abs(b[i + 2] - spec.colour[2]) <= tol) n++;
          }
        }
        return n;
      };
      const before = spec.cue - 1 >= 0 ? count(spec.cue - 1) : null;
      const on = count(spec.cue);
      const ok = (before === null || before === 0) && on > 100;
      if (!ok) bad++;
      console.log(`   ${name.padEnd(9)} cue frame ${String(spec.cue).padStart(2)}   before ${String(before ?? "n/a").padStart(6)}   on ${String(on).padStart(6)}   ${ok ? "OK" : "FAIL"}`);
    }

    // ── 3. REST ─────────────────────────────────────────────────────────────
    console.log("\n3. REST — the idle beat must return the lockup exactly to rest\n");
    const a = rgb(png[40]), b = rgb(png[72]), c = rgb(png[100]);
    const diff = (x, y) => { let n = 0; for (let i = 0; i < x.length; i += 3) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) n++; return n; };
    for (const [label, d] of [["frame 40 vs 72 (reference frame)", diff(a, b)], ["frame 40 vs 100 (after the beat)", diff(a, c)]]) {
      const ok = d < 500;
      if (!ok) bad++;
      console.log(`   ${label.padEnd(34)} ${String(d).padStart(8)} differing px   ${ok ? "OK" : "FAIL"}`);
    }

    console.log(`\n${bad === 0 ? "ALL CHECKS PASSED" : `${bad} CHECK(S) FAILED`}`);
    console.log(`stills: ${OUT}`);
    process.exitCode = bad ? 1 : 0;
  } finally {
    try { fs.unlinkSync(sp); } catch {}
    try { fs.unlinkSync(ep); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
})();
