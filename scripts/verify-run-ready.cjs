/**
 * RUN SF "GET READY TO RUN" — verification.
 *
 *   node scripts/verify-run-ready.cjs
 *
 * Three objective checks, all against rendered pixels rather than intent:
 *   1. FIDELITY  — the settled frame vs. the recovered geometry rasterised analytically
 *                  at the scene's own scale and offset. What is asserted is the artwork's
 *                  outer edges (to the pixel) and its total ink (to 1%): Chromium snaps
 *                  axis-aligned edges to quarter-pixels, so on 7px bars a per-pixel
 *                  coverage IoU sits around 92% however correct the geometry is — it is
 *                  reported for context, not used as the test. That the geometry itself
 *                  is the artwork is settled at 1:1 by scripts/build-run-ready.cjs, which
 *                  round-trips it against the source PNG to 99.97%.
 *   2. ONSETS    — each word's own bbox is empty on the frame before its cue and
 *                  filled on the cue frame, and empty again once it has cleared.
 *   3. REST      — nothing moves between the last word settling and the first exit.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderStill } = require("@remotion/renderer");

const ROOT = path.join(__dirname, "..");
const { scene, durationInFrames, CUE, EXITS, EXIT_FRAMES } = require("./build-run-ready-scene.cjs");
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "public/assets/run-ready/ready.json"), "utf8"));

const W = 3840, H = 2160;
const SCALE = 3200 / 3478;
const OFF_X = (W - geo.width * SCALE) / 2;
const OFF_Y = (H - geo.height * SCALE) / 2;
const SETTLED = CUE.exitStart - 1;   // last frame before anything starts leaving
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "run-ready-"));

const rgba = (file) => execFileSync("ffmpeg",
  ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 30 });

/** Alpha coverage 0..255 at full canvas size. */
function alpha(file) {
  const buf = rgba(file);
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = buf[i * 4 + 3];
  return m;
}

/** Binary mask from coverage, for bbox and emptiness questions. */
const binarize = (m) => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] >= 128 ? 1 : 0; return o; };
const alphaMask = (file) => binarize(alpha(file));

const bboxOf = (m) => {
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) {
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, n };
};

const countIn = (m, box) => {
  let n = 0;
  for (let y = Math.max(0, box[1]); y <= Math.min(H - 1, box[3]); y++)
    for (let x = Math.max(0, box[0]); x <= Math.min(W - 1, box[2]); x++) if (m[y * W + x]) n++;
  return n;
};

/**
 * Exact-coverage rasterisation of the recovered bars at the scene's transform. Every
 * mark is an axis-aligned rectangle, so a pixel's alpha is just the area of its
 * overlap with the rect — no sampling, no filter, nothing to tune.
 */
function reference() {
  const cov = new Float64Array(W * H);
  for (const w of geo.words) {
    for (const g of w.glyphs) {
      for (const m of g.d.matchAll(/M([\d.-]+) ([\d.-]+)H([\d.-]+)V([\d.-]+)H/g)) {
        const x0 = OFF_X + +m[1] * SCALE, y0 = OFF_Y + +m[2] * SCALE;
        const x1 = OFF_X + +m[3] * SCALE, y1 = OFF_Y + +m[4] * SCALE;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const fy = Math.min(y + 1, y1) - Math.max(y, y0);
          if (fy <= 0 || y < 0 || y >= H) continue;
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const fx = Math.min(x + 1, x1) - Math.max(x, x0);
            if (fx <= 0 || x < 0 || x >= W) continue;
            cov[y * W + x] += fx * fy;
          }
        }
      }
    }
  }
  const m = new Uint8Array(W * H);
  for (let i = 0; i < cov.length; i++) m[i] = Math.round(Math.min(1, cov[i]) * 255);
  return m;
}

/** A word's bbox in final-frame pixels, padded for the rise it animates through. */
const wordBox = (w, pad = 40) => [
  Math.round(OFF_X + w.bbox[0] * SCALE) - pad, Math.round(OFF_Y + w.bbox[1] * SCALE) - pad,
  Math.round(OFF_X + w.bbox[2] * SCALE) + pad, Math.round(OFF_Y + w.bbox[3] * SCALE) + pad,
];

(async () => {
  const scenesDir = path.join(ROOT, "remotion", "scenes");
  const tag = `_verify_ready_${Date.now().toString(36)}`;
  const sp = path.join(scenesDir, `${tag}.tsx`), ep = path.join(scenesDir, `${tag}.entry.tsx`);
  fs.writeFileSync(sp, scene);
  fs.writeFileSync(ep, `
import { registerRoot, Composition } from "remotion";
import React from "react";
import Scene from "./${tag}";
registerRoot(() => (<Composition id="Ready" component={Scene}
  durationInFrames={${durationInFrames}} fps={25} width={${W}} height={${H}} />));
`);

  const failures = [];
  try {
    const serveUrl = await bundle({ entryPoint: ep, publicDir: path.join(ROOT, "public/assets/run-ready") });
    const composition = await selectComposition({ serveUrl, id: "Ready" });
    const render = async (frame) => {
      const out = path.join(TMP, `f${frame}.png`);
      await renderStill({ composition, serveUrl, output: out, frame, imageFormat: "png" });
      return out;
    };

    // ── 1. FIDELITY ──────────────────────────────────────────────────────────
    const settled = await render(SETTLED);
    const av = alpha(settled), bv = reference();
    let smin = 0, smax = 0;
    for (let i = 0; i < av.length; i++) {
      const x = av[i], y = bv[i];
      smin += x < y ? x : y;
      smax += x > y ? x : y;
    }
    const iou = smin / smax;
    const a = binarize(av), b = binarize(bv);
    const ba = bboxOf(a), bb = bboxOf(b);
    console.log(`FIDELITY  frame ${SETTLED} vs ${path.basename(geo.source)} geometry at ${(SCALE * 100).toFixed(3)}%`);
    let inkA = 0, inkB = 0;
    for (let i = 0; i < av.length; i++) { inkA += av[i]; inkB += bv[i]; }
    console.log(`  total ink  ${(inkA / inkB).toFixed(5)}x the geometry's own coverage`);
    console.log(`  coverage IoU ${(iou * 100).toFixed(2)}%  (Chromium quarter-pixel snapping floors this near 92%)`);
    console.log(`  rendered   x ${ba.x0}-${ba.x1}  y ${ba.y0}-${ba.y1}  ${ba.n} px`);
    console.log(`  geometry   x ${bb.x0}-${bb.x1}  y ${bb.y0}-${bb.y1}  ${bb.n} px`);
    console.log(`  offset     dx ${ba.x0 - bb.x0}/${ba.x1 - bb.x1}  dy ${ba.y0 - bb.y0}/${ba.y1 - bb.y1} px`);
    if (Math.abs(inkA / inkB - 1) > 0.01) failures.push(`total ink off by ${((inkA / inkB - 1) * 100).toFixed(2)}%`);
    if (iou < 0.90) failures.push(`coverage IoU ${(iou * 100).toFixed(2)}% < 90% — worse than edge snapping explains`);
    for (const [k, v] of Object.entries({ x0: ba.x0 - bb.x0, x1: ba.x1 - bb.x1, y0: ba.y0 - bb.y0, y1: ba.y1 - bb.y1 })) {
      if (Math.abs(v) > 1) failures.push(`artwork edge ${k} off by ${v}px`);
    }

    // ── 2. ONSETS ────────────────────────────────────────────────────────────
    console.log(`\nONSETS`);
    const order = ["GET", "READY", "TO", "RUN"];
    for (const [i, name] of order.entries()) {
      const w = geo.words.find((q) => q.text === name);
      const box = wordBox(w);
      const start = CUE[name];
      const gone = Math.ceil(EXITS[i] + EXIT_FRAMES);
      const before = start > 0 ? countIn(alphaMask(await render(start - 1)), box) : 0;
      const on = countIn(alphaMask(await render(start)), box);
      const after = countIn(alphaMask(await render(Math.min(gone, durationInFrames - 1))), box);
      const ok = on > 0 && after === 0 && (start === 0 || before === 0);
      console.log(`  ${name.padEnd(5)} in ${String(start).padStart(2)}  before ${String(before).padStart(6)}  on ${String(on).padStart(6)}  out ${String(gone).padStart(2)} -> ${after}  ${ok ? "ok" : "FAIL"}`);
      if (!ok) failures.push(`${name}: before=${before} on=${on} after=${after}`);
      // Neighbouring words overlap this padded box only on row-mates; that is fine,
      // the check that matters is empty-before / filled-on for the word's own frame.
    }

    // ── 3. REST ──────────────────────────────────────────────────────────────
    // The card must be visually frozen once the last word has landed. The spring's
    // tail is asymptotic, so compare pixels with a 1/255 tolerance rather than
    // demanding byte-identical files: anything above that is real motion.
    const r0 = rgba(await render(CUE.exitStart - 6));
    const r1 = rgba(settled);
    let maxd = 0, moved = 0;
    for (let i = 0; i < r0.length; i++) {
      const d = Math.abs(r0[i] - r1[i]);
      if (d > maxd) maxd = d;
      if (d > 1) moved++;
    }
    console.log(`\nREST      frames ${CUE.exitStart - 6} -> ${SETTLED}: max channel delta ${maxd}, ${moved} channels moved by >1`);
    if (moved > 0) failures.push(`the settled card drifts before the exit (${moved} channels, max ${maxd})`);
  } finally {
    try { fs.unlinkSync(sp); } catch {}
    try { fs.unlinkSync(ep); } catch {}
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log(`\nall checks passed`);
})();
