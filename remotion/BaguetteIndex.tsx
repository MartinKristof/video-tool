import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { BRAND, BRAND_FONT_FACE_CSS } from "./theme";
import { springIn, ambientDrift, SPRINGS, TIMING } from "./motion";

// =============================================================================
// "The Baguette Index" — ~84s vertical (9:16) social short.
// Story: an AI agent (Brigitte) called 5,000 French bakeries to map the price
// of a baguette; Apify supplied the bakery list + phone numbers that made the
// whole agent pipeline possible. Built to the Apify marketing brand (orange on
// #161718), reusing the motion.ts spring helpers.
// =============================================================================

const C = BRAND.colors;
const F = BRAND.fonts;
const ACCENT = C.orange;

// Scene content durations (frames @ 30fps). Transitions overlap adjacent
// sequences, so the composition total subtracts one transition per boundary.
const SCENE_DUR = [300, 285, 180, 540, 420, 540, 360];
const XFADE = 18;

export const fps = 30;
export const durationInFrames =
  SCENE_DUR.reduce((a, b) => a + b, 0) - XFADE * (SCENE_DUR.length - 1); // 2517

// ---------------------------------------------------------------------------
// Small deterministic helpers (no Math.random — renders must be reproducible).
// ---------------------------------------------------------------------------

// Golden-angle spiral scatter, kept inside `maxR` so points land within France.
function scatter(n: number, cx: number, cy: number, maxR: number) {
  return Array.from({ length: n }, (_, i) => {
    const r = maxR * Math.sqrt((i + 0.5) / n);
    const a = i * 2.399963229; // golden angle
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

// Stable 0→1 hash for per-dot "price" intensity.
function hash01(i: number) {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// France as "l'Hexagone" — the country's own nickname, and a clean motif.
function hexPoints(cx: number, cy: number, r: number) {
  return [-90, -30, 30, 90, 150, 210]
    .map((d) => {
      const a = (d * Math.PI) / 180;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    })
    .join(" ");
}

const HexFrance: React.FC<{
  size: number;
  clipId: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ size, clipId, fill = C.card, stroke = C.border, strokeWidth = 1.4, children, style }) => {
  const pts = hexPoints(50, 50, 46);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
      <defs>
        <clipPath id={clipId}>
          <polygon points={pts} />
        </clipPath>
      </defs>
      <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <g clipPath={`url(#${clipId})`}>{children}</g>
      <polygon points={pts} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </svg>
  );
};

// Animated count-up, eased by a LIQUID spring. Not a hook: `spring` is a pure
// frame-to-value computation, and the use* name tripped rules-of-hooks.
function countUp(frame: number, vfps: number, target: number, delay: number) {
  const p = spring({ frame, fps: vfps, delay, config: SPRINGS.LIQUID });
  return Math.round(interpolate(p, [0, 1], [0, target]));
}

const Baguette: React.FC<{ size: number; rotate?: number }> = ({ size, rotate = -18 }) => (
  <svg width={size} height={size * 0.5} viewBox="0 0 200 100" style={{ transform: `rotate(${rotate}deg)` }}>
    <rect x="8" y="30" width="184" height="40" rx="20" fill="#E8B765" stroke="#C8923B" strokeWidth="3" />
    {[60, 90, 120, 150].map((x) => (
      <line key={x} x1={x} y1="40" x2={x + 14} y2="60" stroke="#A9701F" strokeWidth="4" strokeLinecap="round" />
    ))}
  </svg>
);

const Burger: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size * 0.75} viewBox="0 0 120 90">
    <path d="M12 34 q48 -34 96 0 z" fill="#E8B765" />
    <rect x="10" y="34" width="100" height="12" rx="6" fill="#7BA84F" />
    <rect x="10" y="46" width="100" height="16" rx="5" fill="#7A4A2B" />
    <rect x="12" y="62" width="96" height="16" rx="8" fill="#E8B765" />
  </svg>
);

// A rounded "step" chip used in the data-dependency chain.
const Chip: React.FC<{ label: string; active?: boolean; style?: React.CSSProperties; base: number }> = ({
  label,
  active,
  style,
  base,
}) => (
  <div
    style={{
      background: active ? C.orangeTint : C.card,
      border: `${Math.max(2, base * 0.0022)}px solid ${active ? ACCENT : C.border}`,
      borderRadius: base * 0.018,
      padding: `${base * 0.016}px ${base * 0.026}px`,
      fontFamily: F.marketing,
      fontWeight: 600,
      fontSize: base * 0.03,
      color: active ? ACCENT : C.text,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {label}
  </div>
);

const Tag: React.FC<{ value: string; p: number; tilt: number; base: number }> = ({
  value,
  p,
  tilt,
  base,
}) => (
  <div
    style={{
      background: C.card,
      border: `${Math.max(2, base * 0.0025)}px solid ${C.border}`,
      borderRadius: base * 0.02,
      padding: `${base * 0.018}px ${base * 0.032}px`,
      fontFamily: F.marketing,
      fontWeight: 700,
      fontSize: base * 0.072,
      color: C.text,
      fontVariantNumeric: "tabular-nums",
      opacity: p,
      transform: `translateY(${interpolate(p, [0, 1], [40, 0])}px) rotate(${interpolate(p, [0, 1], [tilt * 2, tilt])}deg)`,
    }}
  >
    {value}
  </div>
);

// ---------------------------------------------------------------------------
// Scene 1 — HOOK: same bread, wildly different price.
// ---------------------------------------------------------------------------
const SceneHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps: vfps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const bagIn = springIn(frame, vfps, TIMING.entrance, "LIQUID");
  const leftTag = springIn(frame, vfps, TIMING.entrance + 16, "ELASTIC");
  const rightTag = springIn(frame, vfps, TIMING.entrance + 26, "ELASTIC");
  const titleIn = springIn(frame, vfps, TIMING.entrance + 40, "SNAPPY");
  const driftY = ambientDrift(frame, 4, 90, "bag");

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: base * 0.05,
          padding: `0 ${base * 0.06}px`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: base * 0.04,
            transform: `translateY(${driftY}px)`,
          }}
        >
          <Tag value="€0.80" p={leftTag} tilt={-7} base={base} />
          <div style={{ opacity: bagIn, transform: `scale(${interpolate(bagIn, [0, 1], [0.8, 1])})` }}>
            <Baguette size={base * 0.42} />
          </div>
          <Tag value="€1.95" p={rightTag} tilt={7} base={base} />
        </div>

        <div
          style={{
            fontFamily: F.marketing,
            fontWeight: 600,
            fontSize: base * 0.066,
            color: C.text,
            letterSpacing: "-0.02em",
            lineHeight: 1.08,
            textAlign: "center",
            maxWidth: width * 0.84,
            opacity: titleIn,
            transform: `translateY(${interpolate(titleIn, [0, 1], [22, 0])}px)`,
          }}
        >
          Same bread, set by law.{" "}
          <span style={{ color: ACCENT, background: C.orangeTint, padding: `0 ${base * 0.012}px`, borderRadius: base * 0.008 }}>
            So why the price gap?
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
const Row: React.FC<{
  glyph: React.ReactNode;
  label: string;
  p: number;
  base: number;
  accent?: boolean;
}> = ({ glyph, label, p, base, accent }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: base * 0.03,
      opacity: p,
      transform: `translateY(${interpolate(p, [0, 1], [24, 0])}px)`,
    }}
  >
    {glyph}
    <div
      style={{
        fontFamily: F.marketing,
        fontWeight: 600,
        fontSize: base * 0.06,
        color: accent ? ACCENT : C.text,
        letterSpacing: "-0.02em",
      }}
    >
      {label}
    </div>
  </div>
);

// Scene 2 — THE LENS: Big Mac Index → Baguette Index.
// ---------------------------------------------------------------------------
const SceneLens: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps: vfps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const row1 = springIn(frame, vfps, TIMING.entrance, "SNAPPY");
  const arrow = springIn(frame, vfps, TIMING.entrance + 24, "LIQUID");
  const row2 = springIn(frame, vfps, TIMING.entrance + 40, "SNAPPY");

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: base * 0.045,
        }}
      >
        <Row glyph={<Burger size={base * 0.13} />} label="The Big Mac Index" p={row1} base={base} />
        <div
          style={{
            fontSize: base * 0.07,
            color: C.textMuted,
            opacity: arrow,
            transform: `translateY(${interpolate(arrow, [0, 1], [-10, 0])}px)`,
          }}
        >
          ↓
        </div>
        <Row glyph={<Baguette size={base * 0.2} rotate={-12} />} label="The Baguette Index" p={row2} base={base} accent />
        <div
          style={{
            marginTop: base * 0.03,
            fontFamily: F.primary,
            fontWeight: 500,
            fontSize: base * 0.03,
            color: C.textMuted,
            textAlign: "center",
            maxWidth: width * 0.78,
            opacity: springIn(frame, vfps, TIMING.entrance + 60, "GENTLE"),
          }}
        >
          One country, one loaf, neighborhood by neighborhood.
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Scene 3 — MEET BRIGITTE.
// ---------------------------------------------------------------------------
const SceneBrigitte: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps: vfps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const botIn = springIn(frame, vfps, TIMING.entrance, "ELASTIC");
  const bubbleIn = springIn(frame, vfps, TIMING.entrance + 16, "SNAPPY");
  const labelIn = springIn(frame, vfps, TIMING.entrance + 28, "GENTLE");
  const bob = ambientDrift(frame, 5, 70, "bot");

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: base * 0.04,
        }}
      >
        {/* Robot head */}
        <div
          style={{
            opacity: botIn,
            transform: `translateY(${bob}px) scale(${interpolate(botIn, [0, 1], [0.7, 1])})`,
          }}
        >
          <svg width={base * 0.3} height={base * 0.3} viewBox="0 0 100 100">
            <line x1="50" y1="8" x2="50" y2="22" stroke={ACCENT} strokeWidth="3" />
            <circle cx="50" cy="8" r="5" fill={ACCENT} />
            <rect x="20" y="22" width="60" height="52" rx="16" fill={C.card} stroke={C.border} strokeWidth="2" />
            <circle cx="38" cy="46" r="6" fill={ACCENT} />
            <circle cx="62" cy="46" r="6" fill={ACCENT} />
            <rect x="36" y="60" width="28" height="5" rx="2.5" fill={C.textMuted} />
          </svg>
        </div>

        <div
          style={{
            background: C.card,
            border: `${Math.max(2, base * 0.0022)}px solid ${C.border}`,
            borderRadius: base * 0.024,
            padding: `${base * 0.022}px ${base * 0.034}px`,
            fontFamily: F.primary,
            fontWeight: 500,
            fontSize: base * 0.034,
            color: C.text,
            opacity: bubbleIn,
            transform: `translateY(${interpolate(bubbleIn, [0, 1], [16, 0])}px)`,
          }}
        >
          “How much for a baguette tradition?”
        </div>

        <div
          style={{
            fontFamily: F.marketing,
            fontWeight: 600,
            fontSize: base * 0.05,
            color: C.text,
            opacity: labelIn,
          }}
        >
          Meet <span style={{ color: ACCENT }}>Brigitte</span>, an AI agent.
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Scene 4 — THE DATA (Apify) + the WHY: no data, no agent.
// ---------------------------------------------------------------------------
const SceneData: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps: vfps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const hexSize = base * 0.46;
  const pins = scatter(46, 50, 52, 33);
  const count = countUp(frame, vfps, 10000, TIMING.entrance + 10);

  const labelIn = springIn(frame, vfps, TIMING.entrance + 30, "SNAPPY");
  const chainBase = 150; // chain starts ~5s in

  const steps = ["List", "Numbers", "Calls", "Index"];
  const captionIn = springIn(frame, vfps, chainBase + 90, "GENTLE");

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: base * 0.03,
          padding: `0 ${base * 0.05}px`,
        }}
      >
        <HexFrance size={hexSize} clipId="fr-data">
          {pins.map((pt, i) => {
            const p = spring({ frame, fps: vfps, delay: TIMING.entrance + i * 1.4, config: SPRINGS.SNAPPY });
            return (
              <circle
                key={i}
                cx={pt.x}
                cy={pt.y}
                r={1.6}
                fill={ACCENT}
                opacity={p}
                style={{ transform: `translateY(${interpolate(p, [0, 1], [-12, 0])}px)`, transformBox: "fill-box" }}
              />
            );
          })}
        </HexFrance>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: base * 0.012,
            opacity: labelIn,
            transform: `translateY(${interpolate(labelIn, [0, 1], [14, 0])}px)`,
          }}
        >
          <span
            style={{
              fontFamily: F.marketing,
              fontWeight: 700,
              fontSize: base * 0.1,
              color: C.text,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.03em",
            }}
          >
            {count.toLocaleString("en-US")}+
          </span>
          <span style={{ fontFamily: F.marketing, fontWeight: 600, fontSize: base * 0.04, color: C.textMuted }}>
            bakeries
          </span>
        </div>
        <div
          style={{
            fontFamily: F.primary,
            fontWeight: 600,
            fontSize: base * 0.026,
            color: ACCENT,
            letterSpacing: "0.02em",
            opacity: labelIn,
          }}
        >
          scraped from Google Maps with Apify
        </div>

        {/* The dependency chain — the WHY. */}
        <div style={{ display: "flex", alignItems: "center", gap: base * 0.012, marginTop: base * 0.03, flexWrap: "wrap", justifyContent: "center" }}>
          {steps.map((s, i) => {
            const p = springIn(frame, vfps, chainBase + i * 16, "SNAPPY");
            return (
              <React.Fragment key={s}>
                {i > 0 && (
                  <span style={{ color: C.textSubtle, fontSize: base * 0.034, opacity: springIn(frame, vfps, chainBase + i * 16 - 6, "GENTLE") }}>→</span>
                )}
                <div style={{ opacity: p, transform: `translateY(${interpolate(p, [0, 1], [12, 0])}px)` }}>
                  <Chip label={s} base={base} active={i === 0} />
                </div>
              </React.Fragment>
            );
          })}
        </div>

        <div
          style={{
            marginTop: base * 0.02,
            fontFamily: F.primary,
            fontWeight: 500,
            fontSize: base * 0.03,
            color: C.textMuted,
            textAlign: "center",
            maxWidth: width * 0.8,
            lineHeight: 1.3,
            opacity: captionIn,
            transform: `translateY(${interpolate(captionIn, [0, 1], [12, 0])}px)`,
          }}
        >
          No list, no numbers, no calls, no index. An agent is only as good as the data you point it at.
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Scene 5 — THE CALLS: the numbers.
// ---------------------------------------------------------------------------
const SceneCalls: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps: vfps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const stats: { value: number; suffix?: string; label: string; delay: number }[] = [
    { value: 5000, suffix: "+", label: "bakeries called", delay: TIMING.entrance },
    { value: 146, label: "towns and cities", delay: TIMING.entrance + 50 },
    { value: 1638, label: "verified prices", delay: TIMING.entrance + 100 },
  ];

  const hangIn = springIn(frame, vfps, TIMING.entrance + 170, "GENTLE");

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: base * 0.05,
        }}
      >
        {stats.map((s, i) => {
          const count = countUp(frame, vfps, s.value, s.delay);
          const p = springIn(frame, vfps, s.delay, "SNAPPY");
          const drift = ambientDrift(frame, 2, 80 + i * 13, `stat${i}`);
          return (
            <div
              key={s.label}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                opacity: p,
                transform: `translateY(${interpolate(p, [0, 1], [24, 0]) + drift}px)`,
              }}
            >
              <span
                style={{
                  fontFamily: F.marketing,
                  fontWeight: 700,
                  fontSize: base * 0.16,
                  color: i === 2 ? ACCENT : C.text,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.04em",
                  lineHeight: 0.95,
                }}
              >
                {count.toLocaleString("en-US")}
                {s.suffix ?? ""}
              </span>
              <span style={{ fontFamily: F.primary, fontWeight: 500, fontSize: base * 0.032, color: C.textMuted }}>
                {s.label}
              </span>
            </div>
          );
        })}

        <div
          style={{
            marginTop: base * 0.02,
            fontFamily: F.primary,
            fontWeight: 500,
            fontSize: base * 0.028,
            color: C.textSubtle,
            opacity: hangIn,
          }}
        >
          (hung up on 1,000+ times — she kept dialing)
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Scene 6 — THE PAYOFF: the price map.
// ---------------------------------------------------------------------------
const ScenePayoff: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps: vfps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const hexSize = base * 0.62;
  const cells = scatter(34, 50, 52, 34);
  const avg = (interpolate(spring({ frame, fps: vfps, delay: 40, config: SPRINGS.LIQUID }), [0, 1], [0, 125]) / 100).toFixed(2);

  const titleIn = springIn(frame, vfps, TIMING.entrance, "SNAPPY");
  const parisIn = springIn(frame, vfps, 110, "ELASTIC");
  const kickerIn = springIn(frame, vfps, 150, "GENTLE");
  const pulse = 1 + 0.12 * Math.max(0, Math.sin(frame / 6));

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: base * 0.04,
        }}
      >
        <div
          style={{
            fontFamily: F.marketing,
            fontWeight: 600,
            fontSize: base * 0.05,
            color: C.text,
            opacity: titleIn,
            transform: `translateY(${interpolate(titleIn, [0, 1], [18, 0])}px)`,
          }}
        >
          The bread told on the country.
        </div>

        <div style={{ position: "relative" }}>
          <HexFrance size={hexSize} clipId="fr-pay" fill={C.card}>
            {cells.map((pt, i) => {
              const t = hash01(i);
              const p = spring({ frame, fps: vfps, delay: 30 + i * 3, config: SPRINGS.LIQUID });
              return (
                <circle
                  key={i}
                  cx={pt.x}
                  cy={pt.y}
                  r={4.4}
                  fill={`rgba(248,102,6,${(0.12 + 0.8 * t).toFixed(3)})`}
                  opacity={p}
                />
              );
            })}
          </HexFrance>

          {/* Paris hotspot near the north. */}
          <div
            style={{
              position: "absolute",
              left: "52%",
              top: "26%",
              opacity: parisIn,
              transform: `translate(-50%,-50%) scale(${pulse})`,
            }}
          >
            <div style={{ width: base * 0.03, height: base * 0.03, borderRadius: 999, background: C.orangeDeep, boxShadow: `0 0 ${base * 0.02}px ${ACCENT}` }} />
          </div>
          <div
            style={{
              position: "absolute",
              left: "62%",
              top: "20%",
              fontFamily: F.primary,
              fontWeight: 600,
              fontSize: base * 0.026,
              color: ACCENT,
              opacity: parisIn,
            }}
          >
            Paris = priciest
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: base * 0.014, opacity: titleIn }}>
          <span style={{ fontFamily: F.marketing, fontWeight: 700, fontSize: base * 0.12, color: C.text, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.03em" }}>
            €{avg}
          </span>
          <span style={{ fontFamily: F.primary, fontWeight: 500, fontSize: base * 0.032, color: C.textMuted }}>
            average baguette
          </span>
        </div>

        <div
          style={{
            fontFamily: F.primary,
            fontWeight: 500,
            fontSize: base * 0.03,
            color: C.textMuted,
            textAlign: "center",
            maxWidth: width * 0.78,
            opacity: kickerIn,
          }}
        >
          Where you stand matters more than what you buy.
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Scene 7 — CTA: mirror the hook, point them at Apify.
// ---------------------------------------------------------------------------
const SceneCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps: vfps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const mirrorIn = springIn(frame, vfps, TIMING.entrance, "GENTLE");
  const headIn = springIn(frame, vfps, TIMING.entrance + 16, "SNAPPY");
  const pillIn = springIn(frame, vfps, TIMING.entrance + 30, "LIQUID");
  const breathe = 1 + ambientDrift(frame, 0.01, 100, "cta");

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: base * 0.04,
          padding: `0 ${base * 0.06}px`,
        }}
      >
        <div
          style={{
            fontFamily: F.primary,
            fontWeight: 500,
            fontSize: base * 0.034,
            color: C.textMuted,
            textAlign: "center",
            maxWidth: width * 0.8,
            opacity: mirrorIn,
          }}
        >
          That €0.80-to-€1.95 swing is now a map anyone can open.
        </div>

        <div
          style={{
            fontFamily: F.marketing,
            fontWeight: 600,
            fontSize: base * 0.08,
            color: C.text,
            letterSpacing: "-0.025em",
            textAlign: "center",
            opacity: headIn,
            transform: `translateY(${interpolate(headIn, [0, 1], [22, 0])}px)`,
          }}
        >
          It started with one scrape.
        </div>

        <div
          style={{
            border: `${Math.max(2, base * 0.0028)}px solid ${ACCENT}`,
            borderRadius: 999,
            padding: `${base * 0.02}px ${base * 0.05}px`,
            fontFamily: F.primary,
            fontWeight: 600,
            fontSize: base * 0.044,
            color: ACCENT,
            opacity: pillIn,
            transform: `translateY(${interpolate(pillIn, [0, 1], [18, 0])}px) scale(${breathe})`,
          }}
        >
          Build your own → apify.com
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Master composition.
// ---------------------------------------------------------------------------
const scenes = [SceneHook, SceneLens, SceneBrigitte, SceneData, SceneCalls, ScenePayoff, SceneCTA];

export default function BaguetteIndex() {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <style>{BRAND_FONT_FACE_CSS}</style>
      <TransitionSeries>
        {scenes.map((Scene, i) => (
          <React.Fragment key={i}>
            {i > 0 && (
              <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({ durationInFrames: XFADE })}
              />
            )}
            <TransitionSeries.Sequence durationInFrames={SCENE_DUR[i]}>
              <Scene />
            </TransitionSeries.Sequence>
          </React.Fragment>
        ))}
      </TransitionSeries>
    </AbsoluteFill>
  );
}
