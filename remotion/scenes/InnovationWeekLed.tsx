// Innovation Week 2026 — Apify LED/LCD spot.
// 832 x 2496 (1:3 portrait) · 30 fps · 10 s · silent (audio is not played on site).
//
// Brand-awareness spot in bold GT Walsheim typography. Three beats are stacked
// one STEP apart inside a single column and handed off by ONE continuous upward
// roll, so the outgoing beat is still leaving as the next one arrives — the
// frame is never empty and there is never a cut.
// Rules honoured: no fade from/to black (frame 0 already shows the first word
// arriving, the last frame is fully present), no blur on entrances, no
// slide/wipe transitions, every reveal combines opacity + translate + scale,
// nothing freezes (perlin ambient drift on every hold).
import React from "react";
import {
  AbsoluteFill,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import { springIn, ambientDrift } from "../motion";

export const fps = 30;
export const durationInFrames = 300;

// ---- Brand palette (canonical set only; orange is the single accent) -------
const C = {
  bg: "#020202",
  text: "#f4f4f5",
  muted: "#bfc1c5",
  orange: "#F86606",
};
const FONT = "'GT Walsheim', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// GT Walsheim for the browser preview (the render entry loads it separately).
const FONT_CSS = `
@font-face{font-family:'GT Walsheim';src:url('/fonts/GT-Walsheim-Regular.ttf') format('truetype');font-weight:400;font-display:block;}
@font-face{font-family:'GT Walsheim';src:url('/fonts/GT-Walsheim-Medium.ttf') format('truetype');font-weight:500;font-display:block;}
@font-face{font-family:'GT Walsheim';src:url('/fonts/GT-Walsheim-Bold.ttf') format('truetype');font-weight:700;font-display:block;}
@font-face{font-family:'GT Walsheim';src:url('/fonts/GT-Walsheim-Black.ttf') format('truetype');font-weight:900;font-display:block;}
`;

// ---- Beat timing (frames @ 30 fps) ------------------------------------------
// Beat A    0–96   "Turn any website into data."
// Beat B   96–198  "68,000+ ready-to-run tools for AI."
// Beat C  198–300  Apify wordmark lockup + apify.com
const SCROLL_1 = 96;
const SCROLL_2 = 198;
const SCROLL_DUR = 54;
// Beats sit 0.7 canvas heights apart, not a full height: the outgoing block is
// still on screen when the incoming one enters, so the roll never leaves a hole.
const STEP_RATIO = 0.7;

// ---- Roll easing ------------------------------------------------------------
// A velocity profile (smooth ramp to an early peak, exponential decay, then a
// smoothstep tail that takes velocity to EXACTLY zero) integrated into a
// position curve. Velocity starting and ending at zero is what makes the roll
// arrive without the small jolt a clipped exponential leaves behind.
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const RAMP = 0.12;
const TAIL = 0.5;
function rollVel(u: number): number {
  const a = u < RAMP ? u / RAMP : 1;
  const rampIn = a * a * (3 - 2 * a);
  const decay = Math.exp(-2.6 * Math.max(0, u - RAMP));
  let tail = 1;
  if (u > 1 - TAIL) {
    const s = (u - (1 - TAIL)) / TAIL;
    tail = 1 - s * s * (3 - 2 * s);
  }
  return rampIn * decay * tail;
}
// Integrated ONCE into a cumulative table and read back with linear
// interpolation. Re-integrating every frame with a rounded sample count (the
// obvious way to write this) quantises the position: consecutive frames then
// advance by uneven amounts — 94px, 79px, 87px, 72px — and the roll visibly
// stutters even though the curve itself is right. With the table the travel
// decays monotonically to zero, frame by frame.
const ROLL_N = 2048;
const ROLL_CUM: number[] = (() => {
  const c = [0];
  let a = 0;
  for (let i = 0; i < ROLL_N; i++) {
    a += rollVel((i + 0.5) / ROLL_N);
    c.push(a);
  }
  return c.map((v) => v / a);
})();
function easeRoll(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const x = t * ROLL_N;
  const i = Math.floor(x);
  return ROLL_CUM[i] + (ROLL_CUM[i + 1] - ROLL_CUM[i]) * (x - i);
}

type Preset = "SNAPPY" | "LIQUID" | "ELASTIC" | "GENTLE";

// ---- Persistent background: flat #020202, no glow, no gradient --------------
const Background: React.FC = () => <AbsoluteFill style={{ backgroundColor: C.bg }} />;

// ---- Type reveal ------------------------------------------------------------
// Per character: the letter is pulled up into place on a spring while its
// opacity lands in ~4 frames, so it is SOLID and SHARP long before the spring
// settles. Decoupling the two is what stops the entrance reading as a fade.
// The vertical stretch settling back to 1 gives the letter weight as it lands.
const Chars: React.FC<{
  text: string;
  start: number;
  size: number;
  color?: string;
  weight?: number;
  preset?: Preset;
  stagger?: number;
  seed: string;
}> = ({ text, start, size, color = C.text, weight = 400, preset = "SNAPPY", stagger = 1.3, seed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drift = ambientDrift(frame, 1.5, 86, seed);
  return (
    <div
      style={{
        display: "flex",
        fontFamily: FONT,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 0.95,
        letterSpacing: "-0.02em",
        color,
        whiteSpace: "pre",
        transform: `translateY(${drift}px)`,
      }}
    >
      {Array.from(text).map((ch, i) => {
        const d = start + i * stagger;
        const p = springIn(frame, fps, d, preset);
        const op = interpolate(frame, [d, d + 3], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const y = interpolate(p, [0, 1], [size * 0.45, 0]);
        const sy = interpolate(p, [0, 1], [1.08, 1]);
        const sx = interpolate(p, [0, 1], [0.96, 1]);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: op,
              transform: `translateY(${y}px) scale(${sx}, ${sy})`,
              transformOrigin: "50% 100%",
            }}
          >
            {ch}
          </span>
        );
      })}
    </div>
  );
};

// ---- Big number counting up (tabular figures so the line doesn't jitter) ----
const CountUp: React.FC<{ to: number; start: number; dur: number; size: number; seed: string }> = ({
  to,
  start,
  dur,
  size,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = springIn(frame, fps, start, "SNAPPY");
  const op = interpolate(frame, [start, start + 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const t = interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const value = Math.round(to * t);
  const drift = ambientDrift(frame, 1.6, 90, seed);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: 400,
        fontSize: size,
        lineHeight: 0.95,
        letterSpacing: "-0.02em",
        color: C.orange,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        opacity: op,
        transform: `translateY(${interpolate(p, [0, 1], [size * 0.45, 0]) + drift}px) scale(${interpolate(p, [0, 1], [0.96, 1])}, ${interpolate(p, [0, 1], [1.08, 1])})`,
        transformOrigin: "0% 100%",
      }}
    >
      {value.toLocaleString("en-US")}+
    </div>
  );
};

// ---- End lockup: coloured symbol + white "Apify" wordmark, plain apify.com --
const Lockup: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const p1 = springIn(frame, fps, start, "LIQUID");
  const p2 = springIn(frame, fps, start + 10, "LIQUID");
  const op1 = interpolate(frame, [start, start + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const op2 = interpolate(frame, [start + 10, start + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const wmW = width * 0.8;
  const wmH = wmW * (141 / 512);
  const d1 = ambientDrift(frame, 2, 110, "wm");
  const d2 = ambientDrift(frame, 1.5, 95, "url");
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: width * 0.085 }}>
      <Img
        src={staticFile("assets/apify/Apify Logo white Wordmark.svg")}
        style={{
          width: wmW,
          height: wmH,
          opacity: op1,
          transform: `translateY(${interpolate(p1, [0, 1], [wmH * 0.42, 0]) + d1}px) scale(${interpolate(p1, [0, 1], [0.9, 1])})`,
        }}
      />
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 400,
          fontSize: width * 0.072,
          color: C.muted,
          letterSpacing: "0.01em",
          lineHeight: 1,
          opacity: op2,
          transform: `translateY(${interpolate(p2, [0, 1], [34, 0]) + d2}px) scale(${interpolate(p2, [0, 1], [0.96, 1])})`,
        }}
      >
        apify.com
      </div>
    </div>
  );
};

export default function InnovationWeekLed() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const STEP = height * STEP_RATIO;
  const roll =
    STEP *
    (easeRoll(clamp01((frame - SCROLL_1) / SCROLL_DUR)) +
      easeRoll(clamp01((frame - SCROLL_2) / SCROLL_DUR)));

  const side = width * 0.07;
  const big = Math.round(width * 0.2);
  const mid = Math.round(width * 0.13);

  // The arriving beat starts springing as the roll begins, so it rises into
  // place while the previous beat leaves — motion, not a cut.
  const B0 = SCROLL_1 + 4;
  const C0 = SCROLL_2 + 6;

  // Each beat is anchored by its CENTRE, one STEP apart, sitting a touch above
  // the optical middle (a 1:3 canvas reads bottom-heavy otherwise).
  const slot = (i: number, align: "flex-start" | "center"): React.CSSProperties => ({
    position: "absolute",
    left: side,
    right: side,
    top: i * STEP + height * 0.47,
    transform: "translateY(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: align,
  });

  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <style>{FONT_CSS}</style>
      <Background />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-roll}px)` }}>
        {/* Beat A — Turn any website into data. */}
        <div style={slot(0, "flex-start")}>
          <Chars text="Turn" start={-6} size={big} preset="SNAPPY" seed="a0" />
          <Chars text="any" start={4} size={big} preset="LIQUID" stagger={1.6} seed="a1" />
          <Chars text="website" start={13} size={big} preset="SNAPPY" seed="a2" />
          <Chars text="into" start={24} size={big} preset="LIQUID" stagger={1.6} seed="a3" />
          <Chars text="data." start={33} size={big} color={C.orange} preset="ELASTIC" stagger={1.1} seed="a4" />
        </div>

        {/* Beat B — 68,000+ ready-to-run tools for AI. */}
        <div style={slot(1, "flex-start")}>
          <CountUp to={68000} start={B0} dur={50} size={big} seed="b0" />
          <div style={{ height: mid * 0.34 }} />
          <Chars text="ready-to-run" start={B0 + 8} size={mid} preset="SNAPPY" seed="b1" />
          <Chars text="tools for AI." start={B0 + 18} size={mid} preset="LIQUID" stagger={1.5} seed="b2" />
        </div>

        {/* Beat C — wordmark lockup, holds fully present to the last frame */}
        <div style={slot(2, "center")}>
          <Lockup start={C0} />
        </div>
      </div>
    </AbsoluteFill>
  );
}
