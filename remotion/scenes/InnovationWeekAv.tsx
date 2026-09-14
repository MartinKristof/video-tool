// Innovation Week 2026 — Apify audiovisual presentation (stage screens).
// 2560 x 1440 (16:9) · 30 fps · 15 s · silent · English.
//
// Same story as the LED spot with room to breathe: text anchored to a left
// vertical band, a persistent Apify symbol bug top-left, and four beats handed
// off by ONE continuous upward scroll on a spike-then-decay velocity curve.
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
  bg: "#161718",
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
// Beat B  120–240  Get web data · Generate leads · Monitor competitors · Power AI agents
// Beat C  240–345  "68,000+ ready-made tools in Apify Store"
// Beat D  345–450  Apify wordmark lockup + apify.com
const SCROLL_1 = 108;
const SCROLL_2 = 228;
const SCROLL_3 = 333;
const SCROLL_DUR = 50;

// ---- Spike-then-decay easing ------------------------------------------------
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function spikeVel(u: number): number {
  const RAMP = 0.1;
  const s = u < RAMP ? u / RAMP : 1;
  const ramp = s * s * (3 - 2 * s);
  const decay = Math.exp(-5 * Math.max(0, u - RAMP));
  return ramp * (0.04 + 0.96 * decay);
}
const SPIKE_N = 240;
const SPIKE_FULL = (() => {
  let a = 0;
  for (let i = 0; i < SPIKE_N; i++) a += spikeVel((i + 0.5) / SPIKE_N);
  return a;
})();
function easeSpike(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const m = Math.round(t * SPIKE_N);
  let a = 0;
  for (let i = 0; i < m; i++) a += spikeVel((i + 0.5) / SPIKE_N);
  return a / SPIKE_FULL;
}

type Preset = "SNAPPY" | "LIQUID" | "ELASTIC" | "GENTLE";

// ---- Persistent background ---------------------------------------------------
const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const gx = width * 0.72 + ambientDrift(frame, width * 0.06, 280, "glow-x");
  const gy = height * 0.5 + ambientDrift(frame, height * 0.08, 320, "glow-y");
  const r = height * 0.85;
  // A very faint, slowly drifting Apify symbol on the right gives the frame
  // depth and asymmetry; it is decoration on the ground, never a hero.
  const symW = height * 0.92;
  const sx = width * 0.74 + ambientDrift(frame, 18, 240, "sym-x");
  const sy = height * 0.5 + ambientDrift(frame, 12, 210, "sym-y");
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <div
        style={{
          position: "absolute",
          left: gx - r,
          top: gy - r,
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(248,102,6,0.15) 0%, rgba(248,102,6,0.05) 38%, rgba(22,23,24,0) 68%)",
        }}
      />
      <Img
        src={staticFile("assets/apify/Apify symbol white.svg")}
        style={{
          position: "absolute",
          left: sx - symW / 2,
          top: sy - symW / 2,
          width: symW,
          height: symW,
          opacity: 0.045,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, rgba(0,0,0,0.16) 0%, rgba(0,0,0,0) 45%, rgba(0,0,0,0) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

// ---- Words cascading in, one spring each --------------------------------------
const Words: React.FC<{
  words: string[];
  start: number;
  stagger?: number;
  size: number;
  accentLast?: boolean;
  weight?: number;
  preset?: Preset;
  seed: string;
}> = ({ words, start, stagger = 6, size, accentLast = false, weight = 900, preset = "SNAPPY", seed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "nowrap",
        gap: size * 0.22,
        fontFamily: FONT,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 0.95,
        letterSpacing: "-0.03em",
        whiteSpace: "nowrap",
      }}
    >
      {words.map((w, i) => {
        const last = i === words.length - 1;
        const p = springIn(frame, fps, start + i * stagger, last && accentLast ? "ELASTIC" : preset);
        const rise = interpolate(p, [0, 1], [size * 0.5, 0]);
        const scale = interpolate(p, [0, 1], [0.9, 1]);
        const drift = ambientDrift(frame, 1.4, 80 + i * 7, `${seed}-${i}`);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              color: last && accentLast ? C.orange : C.text,
              opacity: p,
              transform: `translateY(${rise + drift}px) scale(${scale})`,
              transformOrigin: "0% 100%",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

// ---- Use-case row: orange dot pops first, then the text rises -------------------
const Bullet: React.FC<{ text: string; start: number; size: number; seed: string }> = ({
  text,
  start,
  size,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pd = springIn(frame, fps, start, "ELASTIC");
  const pt = springIn(frame, fps, start + 4, "SNAPPY");
  const dot = size * 0.26;
  const drift = ambientDrift(frame, 1.5, 88, seed);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.32, transform: `translateY(${drift}px)` }}>
      <div
        style={{
          width: dot,
          height: dot,
          borderRadius: "50%",
          background: C.orange,
          opacity: pd,
          transform: `scale(${interpolate(pd, [0, 1], [0.2, 1])})`,
        }}
      />
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 500,
          fontSize: size,
          lineHeight: 1,
          letterSpacing: "-0.02em",
          color: C.text,
          whiteSpace: "nowrap",
          opacity: pt,
          transform: `translateX(${interpolate(pt, [0, 1], [size * 0.25, 0])}px) translateY(${interpolate(pt, [0, 1], [size * 0.3, 0])}px) scale(${interpolate(pt, [0, 1], [0.94, 1])})`,
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
        fontWeight: 900,
        fontSize: size,
        lineHeight: 0.92,
        letterSpacing: "-0.04em",
        color: C.orange,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [size * 0.4, 0]) + drift}px) scale(${interpolate(p, [0, 1], [0.9, 1])})`,
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
  const drift = ambientDrift(frame, 1.4, 92, seed);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1.05,
        letterSpacing: "-0.02em",
        color: C.muted,
        whiteSpace: "nowrap",
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [size * 0.5, 0]) + drift}px) scale(${interpolate(p, [0, 1], [0.96, 1])})`,
        transformOrigin: "0% 0%",
      }}
    >
      {text}
    </div>
  );
};

// ---- End lockup ------------------------------------------------------------------------
const Lockup: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p1 = springIn(frame, fps, start, "LIQUID");
  const p2 = springIn(frame, fps, start + 10, "LIQUID");
  const wmW = width * 0.42;
  const wmH = wmW * (141 / 512);
  const d1 = ambientDrift(frame, 2, 110, "wm");
  const d2 = ambientDrift(frame, 1.5, 95, "pill");
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: height * 0.07 }}>
      <Img
        src={staticFile("assets/apify/Apify Logo white Wordmark.svg")}
        style={{
          width: wmW,
          height: wmH,
          opacity: p1,
          transform: `translateY(${interpolate(p1, [0, 1], [wmH * 0.5, 0]) + d1}px) scale(${interpolate(p1, [0, 1], [0.88, 1])})`,
        }}
      />
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 500,
          fontSize: height * 0.052,
          color: C.text,
          letterSpacing: "-0.01em",
          lineHeight: 1,
          border: `${Math.max(2, height * 0.004)}px solid ${C.orange}`,
          borderRadius: 999,
          padding: `${height * 0.02}px ${height * 0.05}px`,
          opacity: p2,
          transform: `translateY(${interpolate(p2, [0, 1], [40, 0]) + d2}px) scale(${interpolate(p2, [0, 1], [0.92, 1])})`,
        }}
      >
        apify.com
      </div>
    </div>
  );
};

// ---- Persistent symbol bug, top-right (outside the scroll, present from frame 0) ------
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

  const scroll =
    height *
    (easeSpike(clamp01((frame - SCROLL_1) / SCROLL_DUR)) +
      easeSpike(clamp01((frame - SCROLL_2) / SCROLL_DUR)) +
      easeSpike(clamp01((frame - SCROLL_3) / SCROLL_DUR)));

  const left = width * 0.08;
  const headline = Math.round(height * 0.15);
  const bullet = Math.round(height * 0.1);
  const stat = Math.round(height * 0.3);
  const sub = Math.round(height * 0.068);

  const B0 = SCROLL_1 + 3;
  const C0 = SCROLL_2 + 3;
  const D0 = SCROLL_3 + 6;

  const slot = (i: number, align: "flex-start" | "center"): React.CSSProperties => ({
    position: "absolute",
    left: align === "center" ? 0 : left,
    right: align === "center" ? 0 : left,
    top: i * height,
    height,
    display: "flex",
    flexDirection: "column",
    alignItems: align,
    justifyContent: "center",
  });

  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <style>{FONT_CSS}</style>
      <Background />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-scroll}px)` }}>
        {/* Beat A — Turn any website into data. */}
        <div style={{ ...slot(0, "flex-start"), gap: headline * 0.12 }}>
          <Words words={["Turn", "any", "website"]} start={-6} size={headline} seed="a" />
          <Words words={["into", "data."]} start={14} size={headline} accentLast seed="b" />
        </div>

        {/* Beat B — four things people do with Apify */}
        <div style={{ ...slot(1, "flex-start"), gap: bullet * 0.55 }}>
          <Bullet text="Get web data" start={B0} size={bullet} seed="u0" />
          <Bullet text="Generate leads" start={B0 + 10} size={bullet} seed="u1" />
          <Bullet text="Monitor competitors" start={B0 + 20} size={bullet} seed="u2" />
          <Bullet text="Power AI agents" start={B0 + 30} size={bullet} seed="u3" />
        </div>

        {/* Beat C — the Store number */}
        <div style={{ ...slot(2, "flex-start"), gap: sub * 0.5 }}>
          <CountUp to={68000} start={C0} dur={54} size={stat} seed="s0" />
          <Sub text="ready-made tools in Apify Store" start={C0 + 10} size={sub} seed="s1" />
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
