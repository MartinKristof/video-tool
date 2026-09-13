/**
 * RUN SF "GET READY TO RUN": generate the scene.
 *
 *   node scripts/build-run-ready-scene.cjs      # write data/run-ready/scene.tsx
 *
 * Same motion language as the five voice-over lines (scripts/build-run-sf-scene.cjs):
 * words land opaque on their frame with a spring pop and a short per-letter ripple,
 * then sit perfectly still. Geometry is inlined rather than fetched so the scene is
 * self-contained in the app's eval'd preview.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FPS = 25;

// Filip's timecodes, at 25fps. The clip starts on the first one.
const TC = {
  GET: "00:00:22:05",
  READY: "00:00:22:08",
  TO: "00:00:22:13",
  RUN: "00:00:22:16",
  exitStart: "00:00:23:12",
  exitEnd: "00:00:24:09",
};
const EXIT_FRAMES = 5;   // frames one word takes to clear — same settle-out as the lines
const TAIL = 2;          // frames of empty canvas after the last word is gone

const toFrames = (t) => {
  const [h, m, s, f] = t.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * FPS + f;
};
const tc = (f) => {
  const s = Math.floor(f / FPS);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f % FPS]
    .map((n) => String(n).padStart(2, "0")).join(":");
};

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "public/assets/run-ready/ready.json"), "utf8"));
const ORDER = ["GET", "READY", "TO", "RUN"];
const words = ORDER.map((t) => {
  const w = geo.words.find((q) => q.text === t);
  if (!w) throw new Error(`geometry has no word "${t}" — rerun scripts/build-run-ready.cjs`);
  return w;
});

const ABS = Object.fromEntries(Object.entries(TC).map(([k, v]) => [k, toFrames(v)]));
const START = ABS.GET;
const CUE = Object.fromEntries(Object.entries(ABS).map(([k, v]) => [k, v - START]));

// The card clears across Filip's 23:12 -> 24:09 window. That is 22 frames, far too
// long for one settle-out, so the words leave in the order they arrived: each takes
// the usual EXIT_FRAMES, the first starts on 23:12 and the last finishes on 24:09.
const exitSpan = CUE.exitEnd - EXIT_FRAMES - CUE.exitStart;
const EXITS = ORDER.map((_, i) => +(CUE.exitStart + (exitSpan * i) / (ORDER.length - 1)).toFixed(3));
const durationInFrames = CUE.exitEnd + TAIL;

// Cap height must match the five text blocks exactly: both are exports of the same
// Figma type at 360u caps, and the lines are laid out at 3478u -> 3200px.
const SCALE_NUM = 3200, SCALE_DEN = 3478;

const r2 = (n) => +n.toFixed(2);
/** [text, entry frame, exit frame, word bbox, [glyph path, centre x, centre y][]] */
const DATA = words
  .map((w, i) => JSON.stringify([
    w.text,
    CUE[w.text],
    EXITS[i],
    w.bbox,
    w.glyphs.map((g) => [g.d, r2((g.bbox[0] + g.bbox[2]) / 2), r2((g.bbox[1] + g.bbox[3]) / 2)]),
  ]))
  .join(",\n  ");

const cueTable = ORDER
  .map((t, i) => `//   ${t.padEnd(5)} ${TC[t]}   frame ${String(CUE[t]).padEnd(3)} exits on ${EXITS[i]}`)
  .join("\n");

const scene = `import React from "react";
import {
  AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing,
} from "remotion";
import { SPRINGS } from "../motion";

export const fps = ${FPS};
export const durationInFrames = ${durationInFrames};

// ─── CUES ────────────────────────────────────────────────────────────────────
// This clip starts at ${TC.GET} (absolute frame ${START}); everything below is
// clip-local. Drop the file at that timecode and every word lands on Filip's frame.
${cueTable}
// The card clears across ${TC.exitStart} -> ${TC.exitEnd} (frames ${CUE.exitStart}-${CUE.exitEnd}); the words
// leave one by one in the order they arrived, the last one gone exactly on ${TC.exitEnd}.

// Geometry recovered from get-ready-to-run.png by scripts/build-run-ready.cjs — every
// mark in this halftone face is an axis-aligned bar, so the PNG inverts back to exact
// vectors. Per word: text, entry frame, exit frame, bbox, and one compound path per
// letter with its centre (the pop and the settle-out both pivot there).
type WordData = [string, number, number, number[], [string, number, number][]];
const WORDS: WordData[] = [
  ${DATA},
] as WordData[];

// Cap height is locked to the five voice-over lines: same 360u type, same 3478u -> 3200px
// layout scale, so this card reads as one size with the rest of the piece.
const SCALE = ${SCALE_NUM} / ${SCALE_DEN};
const VB_W = ${geo.width}, VB_H = ${geo.height};

const INTRA_WORD_STAGGER = 2;   // total frames of ripple across a word, max
const MAX_GLYPH_DELAY = 0.6;    // frames — keeps short words from rippling too slowly
const EXIT_FRAMES = ${EXIT_FRAMES};
const RISE = 22;                // u the letters travel up into place
const EXIT_RISE = 20;           // u a finished word drifts up as it clears
const SETTLED = 1e-3;           // |1 - p| below this is a landed letter, not motion

/**
 * A spring's tail is asymptotic, so it never stops returning new numbers: at 15
 * frames it is still moving the artwork by 0.005u a frame. That is 200x finer than a
 * pixel, but the rasteriser quantises subpixel edges, so it shows up as a faint
 * shimmer along the bars of a card that is supposed to be dead still. Snapping the
 * last thousandth to exactly 1 drops the transform entirely once a letter has landed,
 * which makes the held card pixel-identical frame to frame.
 */
const land = (p: number) => (Math.abs(1 - p) < SETTLED ? 1 : p);

/**
 * One word. Every letter is fully opaque the instant the word lands — the pop is
 * carried by scale + rise, never by a fade, so the arrival reads exactly on the beat.
 * Once settled the word is completely still: no ambient drift, no idle motion.
 */
const Word: React.FC<{ word: WordData; frame: number; vfps: number }> = ({ word, frame, vfps }) => {
  const [, start, exitAt, bbox, glyphs] = word;
  if (frame < start || frame > exitAt + EXIT_FRAMES) return null;

  // Clear at the end: a quick settle-out, not a fade to black.
  const e = interpolate(frame, [exitAt, exitAt + EXIT_FRAMES], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic),
  });
  const wx = (bbox[0] + bbox[2]) / 2;
  const wy = (bbox[1] + bbox[3]) / 2;
  const es = 1 - 0.05 * e;

  const n = glyphs.length;
  const step = n > 1 ? Math.min(MAX_GLYPH_DELAY, INTRA_WORD_STAGGER / (n - 1)) : 0;

  return (
    <g
      opacity={1 - e}
      transform={\`translate(\${wx} \${wy - e * EXIT_RISE}) scale(\${es}) translate(\${-wx} \${-wy})\`}
    >
      {glyphs.map(([d, cx, cy], gi) => {
        const t = frame - start - gi * step;
        if (t < 0) return null;
        const p = land(spring({ frame: t, fps: vfps, config: SPRINGS.SNAPPY }));
        if (p === 1) return <path key={gi} d={d} fill="${geo.fill}" />;
        const s = 0.86 + 0.14 * p;
        const dy = (1 - p) * RISE;
        return (
          <g key={gi} transform={\`translate(\${cx} \${cy + dy}) scale(\${s}) translate(\${-cx} \${-cy})\`}>
            <path d={d} fill="${geo.fill}" />
          </g>
        );
      })}
    </g>
  );
};

// No Background component: the piece is transparent by design, for compositing.
export default function RunSfGetReadyToRun() {
  const frame = useCurrentFrame();
  const { fps: vfps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: VB_W * SCALE,
          height: VB_H * SCALE,
          marginLeft: -(VB_W * SCALE) / 2,
          marginTop: -(VB_H * SCALE) / 2,
        }}
      >
        <svg
          width={VB_W * SCALE}
          height={VB_H * SCALE}
          viewBox={\`0 0 \${VB_W} \${VB_H}\`}
          style={{ overflow: "visible" }}
        >
          {WORDS.map((w, i) => (
            <Word key={i} word={w} frame={frame} vfps={vfps} />
          ))}
        </svg>
      </div>
    </AbsoluteFill>
  );
}
`;

if (require.main === module) {
  const outPath = path.join(ROOT, "data/run-ready/scene.tsx");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, scene);
  console.log(`GET READY TO RUN — ${durationInFrames} frames (${(durationInFrames / FPS).toFixed(2)}s)`);
  console.log(`starts ${TC.GET} (abs ${START}), runs to ${tc(START + durationInFrames)}`);
  ORDER.forEach((t, i) => console.log(`  ${t.padEnd(5)} in ${TC[t]} (${CUE[t]})   out frame ${EXITS[i]} -> ${(EXITS[i] + EXIT_FRAMES)}`));
  console.log(`\nwrote ${outPath} (${(scene.length / 1024).toFixed(1)} KB)`);
}

module.exports = { scene, durationInFrames, START, TC, CUE, EXITS, FPS, EXIT_FRAMES, tc };
