// Innovation Week 2026 — Apify audiovisual presentation (stage screens).
// 2560 x 1440 (16:9) · 30 fps · 15 s · silent · English.
//
// Same story as the LED spot with room to breathe: text anchored to a left
// vertical band, a persistent Apify symbol bug top-right, and four beats stacked
// one STEP apart inside a single column, handed off by ONE continuous upward
// roll — the outgoing beat is still leaving as the next arrives.
// Rules honoured: no fade from/to black, no blur on entrances, no slide/wipe
// transitions, every reveal combines opacity + translate + scale, nothing
// freezes (perlin ambient drift on every hold).
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
export const durationInFrames = 450;

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
// Beat A    0–120  "Turn any website into data."
// Beat B  120–240  the four "Use Apify for" cases, with icons
// Beat C  240–345  "68,000+ ready-to-run tools in Apify Store"
// Beat D  345–450  Apify wordmark lockup + apify.com
const SCROLL_1 = 108;
const SCROLL_2 = 228;
const SCROLL_3 = 333;
const SCROLL_DUR = 58;
// Beats sit 0.82 canvas heights apart, not a full height, so the roll never
// leaves an empty frame between two beats.
const STEP_RATIO = 0.82;

// The four use cases, each with its own line icon. Icons are drawn here as
// plain stroked SVG on a 24x24 grid — no icon font, no external asset, so they
// scale cleanly to any canvas and always match the accent colour.
const USE_CASES: { label: string; icon: React.ReactNode }[] = [
  {
    label: "Lead generation",
    // horseshoe magnet
    icon: <path d="M4 3h5v9a3 3 0 0 0 6 0V3h5v9a8 8 0 0 1-16 0V3" />,
  },
  {
    label: "Pricing intelligence",
    // currency mark
    icon: (
      <g>
        <path d="M12 1.5v21" />
        <path d="M17 5.5H9.6a3.4 3.4 0 0 0 0 6.8h4.8a3.4 3.4 0 0 1 0 6.8H6.5" />
      </g>
    ),
  },
  {
    label: "Product research",
    // product tile under a magnifier
    icon: (
      <g>
        <rect x="2" y="2" width="12" height="12" rx="2.5" />
        <circle cx="15.5" cy="15.5" r="5" />
        <path d="M19.2 19.2 22.4 22.4" />
      </g>
    ),
  },
  {
    label: "Social media monitoring",
    // two people
    icon: (
      <g>
        <circle cx="9" cy="7.6" r="3.2" />
        <path d="M2.8 19.6a6.2 6.2 0 0 1 12.4 0" />
        <circle cx="17.6" cy="9" r="2.5" />
        <path d="M16.6 13.9a5.2 5.2 0 0 1 4.6 4.6" />
      </g>
    ),
  },
];

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

// ---- Persistent background: flat #020202, no glow, no watermark -------------
const Background: React.FC = () => <AbsoluteFill style={{ backgroundColor: C.bg }} />;

// ---- Type reveal ------------------------------------------------------------
// Per character: pulled up into place on a spring while opacity lands in ~4
// frames, so the letter is SOLID and SHARP long before the spring settles.
// Decoupling the two is what stops the entrance reading as a fade.
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

// ---- Use-case row: the icon pops first, then the line arrives -----------------
const Bullet: React.FC<{
  text: string;
  start: number;
  size: number;
  icon: React.ReactNode;
  seed: string;
}> = ({ text, start, size, icon, seed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pd = springIn(frame, fps, start, "ELASTIC");
  const pt = springIn(frame, fps, start + 4, "SNAPPY");
  const opd = interpolate(frame, [start, start + 3], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opt = interpolate(frame, [start + 4, start + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const box = size * 0.92;
  const drift = ambientDrift(frame, 1.5, 88, seed);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.42, transform: `translateY(${drift}px)` }}>
      <svg
        viewBox="0 0 24 24"
        width={box}
        height={box}
        fill="none"
        stroke={C.orange}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          flex: "0 0 auto",
          opacity: opd,
          transform: `scale(${interpolate(pd, [0, 1], [0.55, 1])})`,
        }}
      >
        {icon}
      </svg>
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 400,
          fontSize: size,
          lineHeight: 1,
          letterSpacing: "0em",
          color: C.text,
          whiteSpace: "nowrap",
          opacity: opt,
          transform: `translateX(${interpolate(pt, [0, 1], [size * 0.22, 0])}px) translateY(${interpolate(pt, [0, 1], [size * 0.26, 0])}px) scale(${interpolate(pt, [0, 1], [0.96, 1])})`,
          transformOrigin: "0% 50%",
        }}
      >
        {text}
      </div>
    </div>
  );
};

// ---- Big number counting up -------------------------------------------------------
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
  const drift = ambientDrift(frame, 1.8, 96, seed);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: 400,
        fontSize: size,
        lineHeight: 0.92,
        letterSpacing: "-0.02em",
        color: C.orange,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        opacity: op,
        transform: `translateY(${interpolate(p, [0, 1], [size * 0.36, 0]) + drift}px) scale(${interpolate(p, [0, 1], [0.96, 1])}, ${interpolate(p, [0, 1], [1.07, 1])})`,
        transformOrigin: "0% 100%",
      }}
    >
      {value.toLocaleString("en-US")}+
    </div>
  );
};

// ---- Plain supporting line ---------------------------------------------------------
const Sub: React.FC<{ text: string; start: number; size: number; seed: string }> = ({ text, start, size, seed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = springIn(frame, fps, start, "LIQUID");
  const op = interpolate(frame, [start, start + 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const drift = ambientDrift(frame, 1.4, 92, seed);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: 400,
        fontSize: size,
        lineHeight: 1.05,
        letterSpacing: "-0.02em",
        color: C.muted,
        whiteSpace: "nowrap",
        opacity: op,
        transform: `translateY(${interpolate(p, [0, 1], [size * 0.45, 0]) + drift}px) scale(${interpolate(p, [0, 1], [0.97, 1])})`,
        transformOrigin: "0% 0%",
      }}
    >
      {text}
    </div>
  );
};

// ---- End lockup: wordmark + plain apify.com (no pill) --------------------------------
const Lockup: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
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
  const wmW = width * 0.42;
  const wmH = wmW * (141 / 512);
  const d1 = ambientDrift(frame, 2, 110, "wm");
  const d2 = ambientDrift(frame, 1.5, 95, "url");
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: height * 0.065 }}>
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
          fontSize: height * 0.055,
          color: C.muted,
          letterSpacing: "0.01em",
          lineHeight: 1,
          opacity: op2,
          transform: `translateY(${interpolate(p2, [0, 1], [34, 0]) + d2}px) scale(${interpolate(p2, [0, 1], [0.97, 1])})`,
        }}
      >
        apify.com
      </div>
    </div>
  );
};

// ---- Persistent symbol bug, top-right (outside the roll, present from frame 0) -------
const Bug: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p = springIn(frame, fps, -4, "LIQUID");
  const s = height * 0.06;
  const drift = ambientDrift(frame, 1.2, 120, "bug");
  return (
    <Img
      src={staticFile("assets/apify/Apify symbol colors.svg")}
      style={{
        position: "absolute",
        right: width * 0.08,
        top: height * 0.09 + drift,
        width: s,
        height: s,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [-s * 0.4, 0])}px) scale(${interpolate(p, [0, 1], [0.8, 1])})`,
      }}
    />
  );
};

export default function InnovationWeekAv() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const STEP = height * STEP_RATIO;
  const roll =
    STEP *
    (easeRoll(clamp01((frame - SCROLL_1) / SCROLL_DUR)) +
      easeRoll(clamp01((frame - SCROLL_2) / SCROLL_DUR)) +
      easeRoll(clamp01((frame - SCROLL_3) / SCROLL_DUR)));

  const left = width * 0.08;
  const headline = Math.round(height * 0.15);
  // One column now, so the rows can be big: the longest ("Social media
  // monitoring") measures 1169px here and the row budget is 2150px.
  const bullet = Math.round(height * 0.075);
  const stat = Math.round(height * 0.3);
  const sub = Math.round(height * 0.068);

  const B0 = SCROLL_1 + 3;
  const C0 = SCROLL_2 + 3;
  const D0 = SCROLL_3 + 6;

  // Each beat is anchored by its CENTRE, one STEP apart.
  const slot = (i: number, align: "flex-start" | "center", gap = 0): React.CSSProperties => ({
    position: "absolute",
    left: align === "center" ? 0 : left,
    right: align === "center" ? 0 : left,
    top: i * STEP + height * 0.5,
    transform: "translateY(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: align,
    gap,
  });

  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <style>{FONT_CSS}</style>
      <Background />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-roll}px)` }}>
        {/* Beat A — Turn any website into data. */}
        <div style={slot(0, "flex-start", headline * 0.14)}>
          <Chars text="Turn any website" start={-6} size={headline} preset="SNAPPY" seed="a" />
          <div style={{ display: "flex" }}>
            <Chars text="into " start={16} size={headline} preset="LIQUID" stagger={1.5} seed="b" />
            <Chars text="data." start={24} size={headline} color={C.orange} preset="ELASTIC" stagger={1.1} seed="c" />
          </div>
        </div>

        {/* Beat B — what people use Apify for */}
        <div style={slot(1, "flex-start", bullet * 0.8)}>
          <Sub text="Use Apify for" start={B0} size={Math.round(bullet * 0.9)} seed="uch" />
          <div style={{ display: "flex", flexDirection: "column", gap: bullet * 0.6 }}>
            {USE_CASES.map((u, i) => (
              <Bullet
                key={u.label}
                text={u.label}
                icon={u.icon}
                start={B0 + 6 + i * 10}
                size={bullet}
                seed={`u${i}`}
              />
            ))}
          </div>
        </div>

        {/* Beat C — the Store number */}
        <div style={slot(2, "flex-start", sub * 0.5)}>
          <CountUp to={68000} start={C0} dur={54} size={stat} seed="s0" />
          <Sub text="ready-to-run tools in Apify Store" start={C0 + 10} size={sub} seed="s1" />
        </div>

        {/* Beat D — wordmark lockup, holds fully present to the last frame */}
        <div style={slot(3, "center")}>
          <Lockup start={D0} />
        </div>
      </div>
      <Bug />
    </AbsoluteFill>
  );
}
