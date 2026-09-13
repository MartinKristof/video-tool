/**
 * RUN SF end lockup: generate the scene.
 *
 *   node scripts/build-run-lockup-scene.cjs        # write data/run-lockup/scene.tsx
 *
 * Geometry is inlined (26 KB) rather than fetched — small enough to keep the scene
 * self-contained, which avoids delayRender/fetch entirely in the eval'd preview.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FPS = 25;

// Filip's timecodes, at 25fps. The clip starts on the first one.
const TC = {
  run: "00:00:25:11",
  divider: "00:00:25:15",
  symbol: "00:00:25:19",
  wordmark: "00:00:25:23",
  idleStart: "00:00:27:08",
  idleEnd: "00:00:28:08",
};
const HOLD_AFTER_IDLE = 50; // frames of held lockup after the idle beat (2s)

const toFrames = (t) => {
  const [h, m, s, f] = t.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * FPS + f;
};
const tc = (f) => {
  const s = Math.floor(f / FPS);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f % FPS]
    .map((n) => String(n).padStart(2, "0")).join(":");
};

const ABS = Object.fromEntries(Object.entries(TC).map(([k, v]) => [k, toFrames(v)]));
const START = ABS.run;
const CUES = Object.fromEntries(Object.entries(ABS).map(([k, v]) => [k, v - START]));
const durationInFrames = CUES.idleEnd + HOLD_AFTER_IDLE;

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "public/assets/run-lockup/lockup.json"), "utf8"));

// Symbol triangles animate green -> blue -> orange base, which is not export order.
const ORDER = ["#20A34E", "#246DFF", "#F86606"];
const symbol = ORDER.map((f) => geo.layers.symbol.find((s) => s.fill === f));
if (symbol.some((s) => !s)) throw new Error("symbol triangles missing a brand colour");

const DATA = JSON.stringify({
  runBox: geo.runBox,
  run: geo.layers.run.map((d) => [d.d, d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]]),
  divider: geo.layers.divider,
  symbol: symbol.map((s) => ({ d: s.d, fill: s.fill, bbox: s.bbox })),
  wordmark: geo.layers.wordmark,
});

const scene = `import React from "react";
import {
  AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing,
} from "remotion";
import { SPRINGS } from "../motion";

export const fps = ${FPS};
export const durationInFrames = ${durationInFrames};

// ─── CUES ────────────────────────────────────────────────────────────────────
// This clip starts at ${TC.run} (absolute frame ${START}); everything below is
// clip-local. Drop the file at that timecode and the cues land on Filip's frames.
//   RUN       ${TC.run}   frame ${CUES.run}
//   divider   ${TC.divider}   frame ${CUES.divider}
//   symbol    ${TC.symbol}   frame ${CUES.symbol}
//   wordmark  ${TC.wordmark}   frame ${CUES.wordmark}
//   idle beat ${TC.idleStart} -> ${TC.idleEnd}   frames ${CUES.idleStart}-${CUES.idleEnd}
const CUES = {
  run: ${CUES.run}, divider: ${CUES.divider}, symbol: ${CUES.symbol}, wordmark: ${CUES.wordmark},
  idleStart: ${CUES.idleStart}, idleEnd: ${CUES.idleEnd},
};

// Measured against TEST.00_00_28_08.Still001.png: the artwork sits at 82%, dead
// centre of the 4K frame. Every colour anchor in that still matches to within a
// pixel of antialiasing. Do not change without re-running the IoU check.
const SCALE = 0.82;
const VB_W = ${geo.width}, VB_H = ${geo.height};
const CANVAS_W = 3840, CANVAS_H = 2160;

const IGNITE_SPREAD = 8;   // frames for the dot wavefront to cross RUN
const PUSH_FRAMES = 38;    // the cinematic push is fully settled here, and stays locked
const LETTER_STAGGER = 2;  // frames between wordmark letters
const TRI_STAGGER = 1.5;   // frames between symbol triangles
const RULE_LEN = ${Math.round(geo.layers.divider.bbox[3] - geo.layers.divider.bbox[1])};

const D = ${DATA};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const mix = (a: number[], b: number[], t: number) =>
  \`rgb(\${a[0] + (b[0] - a[0]) * t | 0},\${a[1] + (b[1] - a[1]) * t | 0},\${a[2] + (b[2] - a[2]) * t | 0})\`;

const RUN_BASE = [248, 102, 6];    // #F86606
const RUN_HOT = [255, 196, 140];   // overshoot as a dot snaps back on
const RULE_BASE = [250, 247, 242]; // #FAF7F2
const RULE_HOT = [255, 255, 255];

// Idle beat — an LED refresh sweeping the lockup column by column.
// RUN is built from 16 dot columns ~121u apart. The crest no longer travels at a
// constant rate — see revVel/crestFrame below — so the gap is widest and fastest
// across RUN and narrows as the sweep decelerates through the mark.
const SWEEP_FRAMES = 19;  // frames for the crest to cross the full lockup width
const OFF_FRAMES = 1;     // integer, so every column goes dark for exactly one frame
const RECOVER = 5;        // frames for a column to settle after relighting

// The brand mark never blinks — a logo dropping out for a frame reads as a
// broadcast fault rather than an effect. It takes the sweep as a specular glint
// plus a physical impulse instead, so the beat carries all the way to the right
// edge with the same energy as the dot columns.
const SYM_POP = 0.14, SYM_LIFT = 8, SYM_GLINT = 0.45;
const WORD_POP = 0.1, WORD_LIFT = 8;
const WHITE = [255, 255, 255];

const REST = { off: false, hot: 0 };

// ─── IDLE FLOW ───────────────────────────────────────────────────────────────
// The sweep's SPEED follows the keyframed velocity graph: a smoothstep ramp into
// an early spike, then a long exponential decay with a small floor so the tail
// keeps creeping rather than stopping dead. Same curve as the house typewriter in
// remotion/scenes/AmazonChat.tsx.
function revVel(u: number): number {
  const RAMP = 0.1;
  const s = u < RAMP ? u / RAMP : 1;
  const ramp = s * s * (3 - 2 * s);                      // smoothstep in to the peak
  const decay = Math.exp(-3.6 * Math.max(0, u - RAMP));  // long exponential tail
  return ramp * (0.09 + 0.91 * decay);
}

// Integrate it once at module load: SPIKE[i] is the crest's normalised position
// after i/SPIKE_N of the sweep. Position is the integral of speed, so the crest
// crosses the word in a burst and then creeps on through the mark.
const SPIKE_N = 240;
const SPIKE: number[] = (() => {
  const out = [0];
  let a = 0;
  for (let i = 0; i < SPIKE_N; i++) { a += revVel((i + 0.5) / SPIKE_N); out.push(a); }
  return out.map((v) => v / a);
})();

/** Fractional frame at which the crest reaches normalised x \`u\` — the inverse of SPIKE. */
function crestFrame(u: number): number {
  let lo = 0, hi = SPIKE_N;
  while (lo < hi) { const m = (lo + hi) >> 1; if (SPIKE[m] < u) lo = m + 1; else hi = m; }
  if (lo === 0) return CUES.idleStart;
  const a = SPIKE[lo - 1], b = SPIKE[lo];
  const f = b > a ? (u - a) / (b - a) : 0;
  return CUES.idleStart + ((lo - 1 + f) / SPIKE_N) * SWEEP_FRAMES;
}

/**
 * The idle beat: an LED refresh. The crest sweeps left to right and, as it reaches
 * each column, that column goes dark for a single frame then snaps back on,
 * overshooting bright before settling — a departure board flipping its rows.
 *
 * \`off\` is true on that one frame only; \`hot\` decays 1 -> 0 over RECOVER frames.
 * Outside [idleStart, idleEnd] both are inert, so the lockup is genuinely dead
 * still before and after — including on the reference frame at ${TC.idleEnd}.
 */
function refresh(frame: number, u: number): { off: boolean; hot: number } {
  if (frame < CUES.idleStart || frame > CUES.idleEnd) return REST;
  const t = frame - crestFrame(u);
  if (t < 0) return REST;
  if (t < OFF_FRAMES) return { off: true, hot: 0 };
  const r = Math.min(1, (t - OFF_FRAMES) / RECOVER);
  const decay = (1 - r) * (1 - r);   // snappy settle back to base
  return { off: false, hot: decay };
}

const hexRgb = (h: string) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
];

const cx = (b: number[]) => (b[0] + b[2]) / 2;
const cy = (b: number[]) => (b[1] + b[3]) / 2;
/** Scale + lift about an element's own centre, in SVG user units. */
const about = (b: number[], s: number, dy = 0, rot = 0) =>
  \`translate(\${cx(b)} \${cy(b) + dy}) rotate(\${rot}) scale(\${s}) translate(\${-cx(b)} \${-cy(b)})\`;

/** RUN: 246 dot-matrix dots igniting left to right, like a sign waking up. */
const Run: React.FC<{ frame: number; vfps: number }> = ({ frame, vfps }) => {
  const [x0, , x1] = [D.runBox[0], D.runBox[1], D.runBox[2]];
  const span = x1 - x0;
  return (
    <g>
      {D.run.map((dot: any, i: number) => {
        const u = (dot[1] - x0) / span;
        const t = frame - CUES.run - u * IGNITE_SPREAD;
        if (t < 0) return null;
        const p = spring({ frame: t, fps: vfps, config: SPRINGS.SNAPPY });
        const bb = [dot[1], dot[2], dot[3], dot[4]];
        const fx = refresh(frame, dot[1] / VB_W);
        if (fx.off) return null;   // the dark frame of the refresh sweep
        // Lit from the instant it ignites — the pop is scale, never a fade, so the
        // wavefront reads as dots switching ON rather than easing in.
        return (
          <path
            key={i}
            d={dot[0]}
            fill={fx.hot > 0.004 ? mix(RUN_BASE, RUN_HOT, fx.hot) : "#F86606"}
            transform={about(bb, (0.62 + 0.38 * p) * (1 + 0.2 * fx.hot))}
          />
        );
      })}
    </g>
  );
};

export default function RunLockup() {
  const frame = useCurrentFrame();
  const { fps: vfps } = useVideoConfig();

  // Slow cinematic push, fully settled by PUSH_FRAMES and exactly 1.0 after it, so
  // the lockup is geometrically locked to the reference placement from then on.
  const push = interpolate(frame, [0, PUSH_FRAMES], [1.02, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
  });

  // The rule draws downward from the top. Its length is driven one frame ahead so
  // there is already a visible sliver on the cue frame itself — a draw-on that
  // starts at zero length would make the line effectively arrive a frame late.
  // Opacity stays 1: the reveal is length, never a fade.
  const ruleP = spring({ frame: frame - CUES.divider + 1, fps: vfps, config: SPRINGS.SNAPPY });
  const ruleFx = refresh(frame, D.divider.bbox[0] / VB_W);

  const w = VB_W * SCALE, h = VB_H * SCALE;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: (CANVAS_W - w) / 2,
          top: (CANVAS_H - h) / 2,
          width: w,
          height: h,
          transform: \`scale(\${push})\`,
        }}
      >
        <svg width={w} height={h} viewBox={\`0 0 \${VB_W} \${VB_H}\`} style={{ overflow: "visible" }}>
          <Run frame={frame} vfps={vfps} />

          {/* Divider — draws downward from the top */}
          {frame >= CUES.divider && !ruleFx.off ? (
            <path
              d={D.divider.d}
              stroke={ruleFx.hot > 0.004 ? mix(RULE_BASE, RULE_HOT, ruleFx.hot) : D.divider.stroke}
              strokeWidth={D.divider.strokeWidth * (1 + 0.35 * ruleFx.hot)}
              strokeDasharray={RULE_LEN}
              strokeDashoffset={RULE_LEN * (1 - ruleP)}
            />
          ) : null}

          {/* Apify symbol — green, blue, then the orange base */}
          {D.symbol.map((tri: any, i: number) => {
            const t = frame - CUES.symbol - i * TRI_STAGGER;
            if (t < 0) return null;
            const p = spring({ frame: t, fps: vfps, config: SPRINGS.SNAPPY });
            const fx = refresh(frame, cx(tri.bbox) / VB_W);
            const hot = fx.off ? 1 : fx.hot;   // the off frame is the impulse, not a blackout
            return (
              <path
                key={tri.fill}
                d={tri.d}
                fill={hot > 0.004 ? mix(hexRgb(tri.fill), WHITE, SYM_GLINT * hot) : tri.fill}
                transform={about(tri.bbox, (0.88 + 0.12 * p) * (1 + SYM_POP * hot), -SYM_LIFT * hot, 2 * (1 - p))}
              />
            );
          })}

          {/* "apify" — letters rise in reading order */}
          {D.wordmark.map((letter: any, i: number) => {
            const t = frame - CUES.wordmark - i * LETTER_STAGGER;
            if (t < 0) return null;
            const p = spring({ frame: t, fps: vfps, config: SPRINGS.LIQUID });
            const fx = refresh(frame, cx(letter.bbox) / VB_W);
            const hot = fx.off ? 1 : fx.hot;   // as above: the mark reacts, it never drops out
            return (
              <g
                key={i}
                transform={about(letter.bbox, (0.94 + 0.06 * p) * (1 + WORD_POP * hot), (1 - p) * 26 - WORD_LIFT * hot)}
              >
                {letter.parts.map((part: any, j: number) => (
                  <path key={j} d={part.d} fill={part.fill} fillRule={part.fillRule ?? undefined} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </AbsoluteFill>
  );
}
`;

const outDir = path.join(ROOT, "data/run-lockup");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "scene.tsx"), scene);

if (require.main === module) {
  console.log(`clip starts ${TC.run} (abs frame ${START})`);
  for (const [k, v] of Object.entries(CUES)) {
    console.log(`  ${k.padEnd(10)} clip frame ${String(v).padStart(3)}   ${tc(ABS[k])}`);
  }
  console.log(`duration ${durationInFrames} frames (${(durationInFrames / FPS).toFixed(2)}s) — ends ${tc(START + durationInFrames)}`);
  console.log(`\nwrote ${path.join(outDir, "scene.tsx")} (${(scene.length / 1024).toFixed(1)} KB)`);
}

module.exports = { scene, durationInFrames, CUES, ABS, START, TC, FPS, tc };
