// Innovation Week 2026 — Apify LED/LCD spot.
// 832 x 2496 (1:3 portrait) · 30 fps · 10 s · silent (audio is not played on site).
//
// Brand-awareness spot in bold GT Walsheim typography. Three stacked beats are
// handed off by ONE continuous upward scroll on a spike-then-decay velocity
// curve (fast burst, long ease-out), ending on the Apify wordmark lockup.
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
// Beat A    0–96   "Turn any website into data."
// Beat B   96–198  "68,000+ ready-made tools for AI."
// Beat C  198–300  Apify wordmark lockup + apify.com
const SCROLL_1 = 96;
const SCROLL_2 = 198;
const SCROLL_DUR = 50;

// ---- Spike-then-decay easing ------------------------------------------------
// A velocity profile (fast ramp to a peak, long exponential tail) integrated
// into a position curve, so the scroll whips and then eases for a long time.
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

// ---- Persistent background: dark brand ground + a slowly drifting glow ------
const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const gx = width * 0.5 + ambientDrift(frame, width * 0.14, 260, "glow-x");
  const gy = height * 0.4 + ambientDrift(frame, height * 0.06, 300, "glow-y");
  const r = Math.max(width, height) * 0.5;
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
            "radial-gradient(circle, rgba(248,102,6,0.17) 0%, rgba(248,102,6,0.06) 36%, rgba(22,23,24,0) 68%)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 35%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.14) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

// ---- One stacked line of type: springs up + settles, then drifts ------------
const Line: React.FC<{
  text: string;
  start: number;
  size: number;
  color?: string;
  weight?: number;
  preset?: Preset;
  seed: string;
}> = ({ text, start, size, color = C.text, weight = 900, preset = "SNAPPY", seed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = springIn(frame, fps, start, preset);
  const rise = interpolate(p, [0, 1], [size * 0.55, 0]);
  const scale = interpolate(p, [0, 1], [0.9, 1]);
  const drift = ambientDrift(frame, 1.6, 84, seed);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 0.95,
        letterSpacing: "-0.03em",
        color,
        whiteSpace: "nowrap",
        opacity: p,
        transform: `translateY(${rise + drift}px) scale(${scale})`,
        transformOrigin: "0% 100%",
      }}
    >
      {text}
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
  const t = interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const value = Math.round(to * t);
  const rise = interpolate(p, [0, 1], [size * 0.55, 0]);
  const scale = interpolate(p, [0, 1], [0.9, 1]);
  const drift = ambientDrift(frame, 1.6, 90, seed);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontWeight: 900,
        fontSize: size,
        lineHeight: 0.95,
        letterSpacing: "-0.03em",
        color: C.orange,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        opacity: p,
        transform: `translateY(${rise + drift}px) scale(${scale})`,
        transformOrigin: "0% 100%",
      }}
    >
      {value.toLocaleString("en-US")}+
    </div>
  );
};

// ---- End lockup: coloured symbol + white "Apify" wordmark, apify.com pill ---
const Lockup: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const p1 = springIn(frame, fps, start, "LIQUID");
  const p2 = springIn(frame, fps, start + 10, "LIQUID");
  const wmW = width * 0.8;
  const wmH = wmW * (141 / 512);
  const d1 = ambientDrift(frame, 2, 110, "wm");
  const d2 = ambientDrift(frame, 1.5, 95, "pill");
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: width * 0.09 }}>
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
          fontSize: width * 0.068,
          color: C.text,
          letterSpacing: "-0.01em",
          lineHeight: 1,
          border: `${Math.max(2, width * 0.004)}px solid ${C.orange}`,
          borderRadius: 999,
          padding: `${width * 0.026}px ${width * 0.07}px`,
          opacity: p2,
          transform: `translateY(${interpolate(p2, [0, 1], [40, 0]) + d2}px) scale(${interpolate(p2, [0, 1], [0.92, 1])})`,
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

  // One continuous scroll: each handoff moves the column up by a full canvas.
  const scroll =
    height *
    (easeSpike(clamp01((frame - SCROLL_1) / SCROLL_DUR)) +
      easeSpike(clamp01((frame - SCROLL_2) / SCROLL_DUR)));

  const side = width * 0.07;
  const big = Math.round(width * 0.2);
  const mid = Math.round(width * 0.13);

  // Content of the arriving beat starts springing just after the scroll begins,
  // so it rises into place while the previous beat leaves — motion, not a cut.
  const B0 = SCROLL_1 + 4;
  const C0 = SCROLL_2 + 6;

  const slot = (i: number, align: "flex-start" | "center"): React.CSSProperties => ({
    position: "absolute",
    left: side,
    right: side,
    top: i * height,
    height,
    display: "flex",
    flexDirection: "column",
    alignItems: align,
    justifyContent: "center",
    paddingBottom: height * 0.06,
    boxSizing: "border-box",
  });

  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <style>{FONT_CSS}</style>
      <Background />
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${-scroll}px)` }}>
        {/* Beat A — Turn any website into data. */}
        <div style={slot(0, "flex-start")}>
          <Line text="Turn" start={-6} size={big} seed="a0" />
          <Line text="any" start={3} size={big} seed="a1" />
          <Line text="website" start={12} size={big} seed="a2" />
          <Line text="into" start={21} size={big} seed="a3" />
          <Line text="data." start={30} size={big} color={C.orange} preset="ELASTIC" seed="a4" />
        </div>

        {/* Beat B — 68,000+ ready-made tools for AI. */}
        <div style={slot(1, "flex-start")}>
          <CountUp to={68000} start={B0} dur={54} size={big} seed="b0" />
          <div style={{ height: mid * 0.35 }} />
          <Line text="ready-made" start={B0 + 8} size={mid} seed="b1" />
          <Line text="tools" start={B0 + 16} size={mid} seed="b2" />
          <Line text="for AI." start={B0 + 24} size={mid} seed="b3" />
        </div>

        {/* Beat C — wordmark lockup, holds fully present to the last frame */}
        <div style={slot(2, "center")}>
          <Lockup start={C0} />
        </div>
      </div>
    </AbsoluteFill>
  );
}
