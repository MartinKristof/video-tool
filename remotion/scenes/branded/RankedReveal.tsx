import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  staticFile,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const fps = 25;
export const durationInFrames = 652;

// ============================================================================
// DESIGN TOKENS
// ============================================================================
const C = {
  blue:        "#00AAFF",
  green:       "#4ADE80",
  amber:       "#FBBF24",
  red:         "#EF4444",
  white:       "#FFFFFF",
  muted:       "#9CA3AF",
  navy:        "#16213E",
  // Opaque (ProRes-safe) approximations of rgba surfaces
  cardFill:    "#161A24",
  cardBorder:  "rgba(255,255,255,0.08)",
  accentFill:  "#0E2A40",
  accentBorder:"rgba(0,170,255,0.45)",
  skeletonBg:  "rgba(255,255,255,0.22)",
} as const;

const CANVAS = { w: 3840, h: 2160 };
const SAFE = { x: 250, y: 250, w: CANVAS.w - 500, h: CANVAS.h - 500 }; // 3340 x 1660

const SPR_BASE = { damping: 200 } as const;
const SPR_HERO = { damping: 14, stiffness: 120, mass: 0.6 } as const;

// ============================================================================
// LAYOUT WRAPPERS
// ============================================================================
function Background() {
  return (
    <AbsoluteFill style={{ background: "#04101B" }}>
      <Img
        src={staticFile("assets/backgrounds/background_blue.png")}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
}

function SafeZone({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x,
        top: SAFE.y,
        width: SAFE.w,
        height: SAFE.h,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function PhaseWrapper({
  fadeIn,
  fadeOut,
  duration,
  children,
}: {
  fadeIn: number;
  fadeOut: number;
  duration: number;
  children: React.ReactNode;
}) {
  const frame = useCurrentFrame();
  const opIn = fadeIn > 0
    ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  const opOut = fadeOut > 0
    ? interpolate(frame, [duration - fadeOut, duration], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  return <div style={{ width: "100%", height: "100%", opacity: Math.min(opIn, opOut), position: "relative" }}>{children}</div>;
}

// ============================================================================
// REUSABLE PRIMITIVES
// ============================================================================
function Sparkline({ progress, color = C.blue, w = 180, h = 70 }: { progress: number; color?: string; w?: number; h?: number }) {
  // Upward zig-zag normalized into [0..1] x [0..1] inside the box.
  const points = [
    [0.00, 0.85],
    [0.18, 0.70],
    [0.32, 0.78],
    [0.48, 0.55],
    [0.62, 0.62],
    [0.78, 0.32],
    [1.00, 0.10],
  ];
  const d = "M " + points.map(([x, y]) => `${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`).join(" L ");
  const totalLen = w * 1.4; // rough estimate
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible" }}>
      <path
        d={d}
        stroke={color}
        strokeWidth={5}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={totalLen}
        strokeDashoffset={totalLen * (1 - progress)}
        opacity={Math.min(1, progress * 3)}
      />
    </svg>
  );
}

function ThreeXBadge({ progress }: { progress: number }) {
  const sc = interpolate(progress, [0, 1], [0.4, 1]);
  return (
    <div
      style={{
        position: "absolute",
        top: 24,
        right: 24,
        background: C.blue,
        color: C.white,
        fontSize: 44,
        fontWeight: 800,
        padding: "10px 20px",
        borderRadius: 16,
        fontFamily: "Inter, sans-serif",
        letterSpacing: "0.02em",
        transform: `scale(${sc})`,
        opacity: Math.min(1, progress * 2),
        boxShadow: "0 12px 30px rgba(0,170,255,0.35)",
      }}
    >
      3×
    </div>
  );
}

function XIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill={C.red} />
      <path d="M 8 8 L 16 16 M 16 8 L 8 16" stroke={C.white} strokeWidth={2.5} strokeLinecap="round" />
    </svg>
  );
}

function MagnifierIcon({ size = 280, color = C.blue, drawProgress = 1 }: { size?: number; color?: string; drawProgress?: number }) {
  const len = 90;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ overflow: "visible" }}>
      {/* Grid background */}
      {[0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => (
        <rect key={`${r}-${c}`} x={3 + c * 4.5} y={3 + r * 4.5} width={3.5} height={3.5} stroke={color} strokeWidth={0.4} fill="none" opacity={0.35 * drawProgress} />
      )))}
      {/* Magnifier circle */}
      <circle cx="14" cy="10" r="5.5" stroke={color} strokeWidth={1.5} fill="none"
        strokeDasharray={len} strokeDashoffset={len * (1 - drawProgress)} strokeLinecap="round" />
      {/* Handle */}
      <path d="M 18 14 L 21 17.5" stroke={color} strokeWidth={1.5} strokeLinecap="round"
        strokeDasharray={10} strokeDashoffset={10 * (1 - drawProgress)} />
    </svg>
  );
}

function ClockIcon({ size = 64, color = C.amber }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9.5" stroke={color} strokeWidth={1.8} fill="none" />
      <path d="M 12 7 L 12 12 L 16 14" stroke={color} strokeWidth={2} strokeLinecap="round" fill="none" />
    </svg>
  );
}

function ChevronIcon({ size = 72, color = C.blue }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M 9 6 L 16 12 L 9 18" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function ArrowRight({ width = 280, color = C.blue, progress }: { width?: number; color?: string; progress: number }) {
  const len = width;
  return (
    <svg width={width + 30} height={50} viewBox={`0 0 ${width + 30} 50`} style={{ overflow: "visible" }}>
      <defs>
        <marker id={`arr-${color.replace("#", "")}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
        </marker>
      </defs>
      <path
        d={`M 5 25 L ${width + 5} 25`}
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - progress)}
        markerEnd={progress > 0.95 ? `url(#arr-${color.replace("#", "")})` : undefined}
      />
    </svg>
  );
}

// ============================================================================
// PHASE 1 — 9 channels, 3 spike
// ============================================================================
const CHANNEL_METRICS = ["1.2M", "850K", "2.1M", "640K", "3.4M", "910K", "1.8M", "1.5M", "720K"];
const HIGHLIGHT_IDX = [0, 4, 7];

function ChannelCard({ index }: { index: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const highlightedIdx = HIGHLIGHT_IDX.indexOf(index);
  const highlighted = highlightedIdx >= 0;

  const entry = spring({ frame, fps, delay: 2 + index * 3, config: SPR_BASE });
  const ty = interpolate(entry, [0, 1], [40, 0]);
  const sc = interpolate(entry, [0, 1], [0.85, 1]);

  const hi = interpolate(frame, [38, 52], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const dimOpacity = highlighted ? 1 : interpolate(frame, [38, 52], [1, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Sparkline + 3x badge (highlighted only)
  const sparkProg = spring({ frame, fps, delay: 42, config: SPR_BASE });
  const badgeProg = spring({ frame, fps, delay: 50 + highlightedIdx * 4, config: SPR_HERO });

  const borderOpacity = highlighted ? 0.08 + 0.55 * hi : 0.08;
  const borderWidth = highlighted ? 2 + 0.5 * hi : 2;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: C.cardFill,
        border: `${borderWidth}px solid rgba(${highlighted ? "0,170,255" : "255,255,255"},${borderOpacity})`,
        borderRadius: 28,
        padding: 40,
        display: "flex",
        alignItems: "center",
        gap: 32,
        opacity: entry * dimOpacity,
        transform: `translateY(${ty}px) scale(${sc})`,
        overflow: "hidden",
      }}
    >
      {highlighted && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `rgba(0,170,255,${0.06 * hi})`,
            pointerEvents: "none",
          }}
        />
      )}

      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: "50%",
          background: highlighted ? C.blue : "#2A3344",
          flexShrink: 0,
          zIndex: 1,
        }}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 18, zIndex: 1, minWidth: 0 }}>
        <div style={{ height: 18, width: "72%", background: C.skeletonBg, borderRadius: 9 }} />
        <div
          style={{
            fontSize: 42,
            color: highlighted ? C.white : C.muted,
            fontWeight: 700,
            fontFamily: "Inter, sans-serif",
            letterSpacing: "-0.01em",
          }}
        >
          {CHANNEL_METRICS[index]}
        </div>
        {highlighted && hi > 0.1 && (
          <div
            style={{
              fontSize: 22,
              color: C.blue,
              fontWeight: 600,
              fontFamily: "Inter, sans-serif",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              opacity: hi,
            }}
          >
            VIEWS : SUBS ↑
          </div>
        )}
      </div>

      {highlighted && (
        <>
          <div style={{ position: "absolute", right: 200, bottom: 36, zIndex: 1 }}>
            <Sparkline progress={sparkProg} />
          </div>
          <ThreeXBadge progress={badgeProg} />
        </>
      )}
    </div>
  );
}

function Phase1() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gridTemplateRows: "repeat(3, 1fr)",
        gap: 48,
        padding: 40,
      }}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <ChannelCard key={i} index={i} />
      ))}
    </div>
  );
}

// ============================================================================
// PHASE 2 — Same Topic, Same Time
// ============================================================================
function Phase2() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const chipPositions = [
    { x: SAFE.w * 0.18, y: 180 },
    { x: SAFE.w * 0.50, y: 140 },
    { x: SAFE.w * 0.82, y: 180 },
  ];
  const centerX = SAFE.w / 2;
  const centerY = 700;

  // Connector lines draw simultaneously (same delay)
  const lineProg = spring({ frame, fps, delay: 12, config: { damping: 30, stiffness: 90 } });
  const pillProg = spring({ frame, fps, delay: 24, config: SPR_HERO });

  // Timeline markers converge at delay 30
  const conv = interpolate(frame, [30, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Connector lines */}
      <svg style={{ position: "absolute", inset: 0 }} width={SAFE.w} height={SAFE.h}>
        {chipPositions.map((p, i) => {
          const len = Math.hypot(centerX - p.x, centerY - p.y);
          return (
            <line
              key={i}
              x1={p.x}
              y1={p.y + 80}
              x2={centerX}
              y2={centerY - 30}
              stroke={C.blue}
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray={len}
              strokeDashoffset={len * (1 - lineProg)}
              opacity={0.95}
            />
          );
        })}
      </svg>

      {/* Channel chips */}
      {chipPositions.map((p, i) => {
        const entry = spring({ frame, fps, delay: 4 + i * 4, config: SPR_BASE });
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.x - 240,
              top: p.y,
              width: 480,
              height: 160,
              background: C.cardFill,
              border: `2.5px solid rgba(0,170,255,0.45)`,
              borderRadius: 28,
              padding: 30,
              display: "flex",
              alignItems: "center",
              gap: 22,
              opacity: entry,
              transform: `translateY(${interpolate(entry, [0, 1], [40, 0])}px) scale(${interpolate(entry, [0, 1], [0.88, 1])})`,
            }}
          >
            <div style={{ width: 80, height: 80, borderRadius: "50%", background: C.blue, flexShrink: 0 }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ height: 14, width: "82%", background: C.skeletonBg, borderRadius: 7 }} />
              <div style={{ height: 14, width: "55%", background: C.skeletonBg, borderRadius: 7 }} />
            </div>
          </div>
        );
      })}

      {/* Central topic pill */}
      <div
        style={{
          position: "absolute",
          left: centerX - 360,
          top: centerY - 80,
          width: 720,
          height: 160,
          background: C.accentFill,
          border: `3px solid ${C.blue}`,
          borderRadius: 80,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: pillProg,
          transform: `scale(${interpolate(pillProg, [0, 1], [0.6, 1])})`,
          boxShadow: `0 0 60px rgba(0,170,255,${0.25 + 0.12 * Math.sin(frame / 14)})`,
        }}
      >
        <div
          style={{
            color: C.blue,
            fontSize: 52,
            fontWeight: 800,
            fontFamily: "Inter, sans-serif",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          # THE TOPIC
        </div>
      </div>

      {/* Timeline strip with converging markers */}
      <div
        style={{
          position: "absolute",
          left: 60,
          right: 60,
          bottom: 160,
          height: 3,
          background: C.cardBorder,
        }}
      />
      {[0.2, 0.5, 0.8].map((startX, i) => {
        const finalX = 0.5;
        const x = startX + (finalX - startX) * conv;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `calc(${x * 100}% - 14px)`,
              bottom: 144,
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: C.blue,
              boxShadow: `0 0 22px rgba(0,170,255,0.5)`,
              opacity: spring({ frame, fps, delay: 8 + i * 2, config: SPR_BASE }),
            }}
          />
        );
      })}
    </div>
  );
}

// ============================================================================
// PHASE 3 — Can't see by scrolling (hard cut at f51)
// ============================================================================
const FEED_THUMBS = Array.from({ length: 12 }, (_, i) => ({
  hue: ["#2A3344", "#1F2A3A", "#2A3344", "#283145"][i % 4],
}));

function Phase3() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const INNER_CUT = 51; // f274 - f223 = 51
  if (frame >= INNER_CUT) {
    // Sub-beat: magnifier-over-grid
    const localFrame = frame - INNER_CUT;
    const iconProg = spring({ frame: localFrame, fps, delay: 0, config: SPR_HERO });
    const drawProg = interpolate(localFrame, [4, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const cueProg = spring({ frame: localFrame, fps, delay: 8, config: SPR_BASE });
    return (
      <div style={{ position: "absolute", inset: 0, background: "#04101B", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 40 }}>
        <div style={{ transform: `scale(${iconProg})`, opacity: iconProg }}>
          <MagnifierIcon size={520} color={C.blue} drawProgress={drawProg} />
        </div>
        <div
          style={{
            fontSize: 58,
            color: C.white,
            fontWeight: 700,
            fontFamily: "Inter, sans-serif",
            letterSpacing: "-0.01em",
            opacity: cueProg,
            transform: `translateY(${interpolate(cueProg, [0, 1], [20, 0])}px)`,
          }}
        >
          {"Here's how to catch it"}
        </div>
      </div>
    );
  }

  // Feed sub-beat (frame < 51)
  const feedY = interpolate(frame, [0, INNER_CUT], [0, -2200], { extrapolateLeft: "clamp" });
  const xProg = spring({ frame, fps, delay: 10, config: SPR_HERO });

  const colW = 700;
  const colX = SAFE.w / 2 - colW / 2;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div
        style={{
          position: "absolute",
          left: colX,
          top: 0,
          width: colW,
          height: SAFE.h,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: colW,
            transform: `translateY(${feedY}px)`,
            filter: "blur(6px)",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
          {FEED_THUMBS.map((t, i) => (
            <div key={i} style={{ width: "100%", height: 380, background: t.hue, borderRadius: 24, border: `2px solid ${C.cardBorder}` }} />
          ))}
        </div>
      </div>

      {/* Red X badge */}
      <div
        style={{
          position: "absolute",
          left: SAFE.w / 2 - 60,
          top: SAFE.h / 2 - 60,
          opacity: xProg,
          transform: `scale(${xProg})`,
        }}
      >
        <XIcon size={120} />
      </div>

      {/* Red tag */}
      <div
        style={{
          position: "absolute",
          left: SAFE.w / 2 - 280,
          top: SAFE.h / 2 + 90,
          padding: "16px 32px",
          background: "rgba(239,68,68,0.15)",
          border: `2px solid ${C.red}`,
          borderRadius: 16,
          color: C.red,
          fontSize: 36,
          fontWeight: 700,
          fontFamily: "Inter, sans-serif",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          opacity: xProg,
        }}
      >
        invisible at this speed
      </div>
    </div>
  );
}

// ============================================================================
// PHASE 4 — 1 actor → spreadsheet → ~20 min
// ============================================================================
function Phase4() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const n1 = spring({ frame, fps, delay: 4, config: SPR_BASE });
  const a1 = spring({ frame, fps, delay: 20, config: { damping: 30, stiffness: 100 } });
  const a2 = spring({ frame, fps, delay: 75, config: { damping: 30, stiffness: 100 } });
  const n3 = spring({ frame, fps, delay: 85, config: SPR_HERO });

  const nodeW = 720;
  const nodeH = 540;
  const gap = 120;
  const totalW = nodeW * 3 + gap * 2;
  const startX = (SAFE.w - totalW) / 2;
  const centerY = SAFE.h / 2 - nodeH / 2;

  // Spreadsheet cells fill cascade
  const COLS = 5, ROWS = 4;
  const cells = Array.from({ length: COLS * ROWS }, (_, idx) => {
    const p = spring({ frame, fps, delay: 40 + idx * 2, config: SPR_BASE });
    return p;
  });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Node 1: Apify actor */}
      <div
        style={{
          position: "absolute",
          left: startX,
          top: centerY,
          width: nodeW,
          height: nodeH,
          background: C.accentFill,
          border: `2.5px solid ${C.accentBorder}`,
          borderRadius: 32,
          padding: 56,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 36,
          opacity: n1,
          transform: `translateY(${interpolate(n1, [0, 1], [50, 0])}px) scale(${interpolate(n1, [0, 1], [0.88, 1])})`,
        }}
      >
        <Img src={staticFile("assets/apify/Apify Logo white Wordmark.svg")} style={{ height: 72 }} />
        <div style={{ fontSize: 200, fontWeight: 900, color: C.blue, lineHeight: 1, fontFamily: "Inter, sans-serif" }}>1</div>
        <div style={{ fontSize: 38, color: C.white, fontWeight: 600, fontFamily: "Inter, sans-serif", letterSpacing: "0.04em", textTransform: "uppercase" }}>
          one actor
        </div>
      </div>

      {/* Arrow 1 */}
      <div style={{ position: "absolute", left: startX + nodeW + 10, top: centerY + nodeH / 2 - 25 }}>
        <ArrowRight width={100} progress={a1} color={C.blue} />
      </div>

      {/* Node 2: spreadsheet */}
      <div
        style={{
          position: "absolute",
          left: startX + nodeW + gap,
          top: centerY,
          width: nodeW,
          height: nodeH,
          background: C.cardFill,
          border: `2px solid ${C.cardBorder}`,
          borderRadius: 32,
          padding: 36,
          opacity: spring({ frame, fps, delay: 30, config: SPR_BASE }),
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${COLS}, 1fr)`,
            gridTemplateRows: `repeat(${ROWS}, 1fr)`,
            gap: 12,
            width: "100%",
            height: "100%",
          }}
        >
          {cells.map((p, idx) => (
            <div
              key={idx}
              style={{
                background: "#1F2535",
                borderRadius: 10,
                border: `1px solid ${C.cardBorder}`,
                display: "flex",
                alignItems: "center",
                padding: "0 14px",
                gap: 8,
              }}
            >
              <div style={{ height: 12, width: `${30 + (idx * 7) % 50}%`, background: C.skeletonBg, borderRadius: 6, opacity: p }} />
            </div>
          ))}
        </div>
      </div>

      {/* Arrow 2 */}
      <div style={{ position: "absolute", left: startX + nodeW * 2 + gap + 10, top: centerY + nodeH / 2 - 25 }}>
        <ArrowRight width={100} progress={a2} color={C.blue} />
      </div>

      {/* Node 3: clock */}
      <div
        style={{
          position: "absolute",
          left: startX + nodeW * 2 + gap * 2,
          top: centerY,
          width: nodeW,
          height: nodeH,
          background: C.accentFill,
          border: `2.5px solid rgba(251,191,36,0.55)`,
          borderRadius: 32,
          padding: 56,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 28,
          opacity: n3,
          transform: `scale(${interpolate(n3, [0, 1], [0.7, 1])})`,
          boxShadow: `0 0 60px rgba(251,191,36,${0.18 + 0.08 * Math.sin(frame / 12)})`,
        }}
      >
        <ClockIcon size={180} color={C.amber} />
        <div style={{ fontSize: 100, fontWeight: 800, color: C.amber, lineHeight: 1, fontFamily: "Inter, sans-serif", letterSpacing: "-0.02em" }}>
          ≈ 20 min
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PHASE 5 — What we're building
// ============================================================================
const P5_CHIPS = ["Channel A", "Channel B", "Channel C", "Channel D", "Channel E"];

function Phase5() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const arrowProg = spring({ frame, fps, delay: 30, config: { damping: 30, stiffness: 80 } });
  const procProg = spring({ frame, fps, delay: 35, config: SPR_BASE });
  const qProg = spring({ frame, fps, delay: 95, config: SPR_HERO });

  const colW = SAFE.w / 3;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Left: chips */}
      <div
        style={{
          position: "absolute",
          left: 60,
          top: SAFE.h / 2 - 360,
          width: colW - 100,
          display: "flex",
          flexDirection: "column",
          gap: 26,
        }}
      >
        <div style={{ fontSize: 26, color: C.muted, fontWeight: 600, fontFamily: "Inter, sans-serif", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 14, opacity: spring({ frame, fps, delay: 2, config: SPR_BASE }) }}>
          channels you care about
        </div>
        {P5_CHIPS.map((label, i) => {
          const p = spring({ frame, fps, delay: 4 + i * 7, config: SPR_BASE });
          return (
            <div
              key={i}
              style={{
                background: C.accentFill,
                border: `2px solid ${C.accentBorder}`,
                borderRadius: 80,
                padding: "22px 38px",
                color: C.white,
                fontSize: 36,
                fontWeight: 600,
                fontFamily: "Inter, sans-serif",
                opacity: p,
                transform: `translateX(${interpolate(p, [0, 1], [-30, 0])}px) scale(${interpolate(p, [0, 1], [0.9, 1])})`,
              }}
            >
              {label}
            </div>
          );
        })}
      </div>

      {/* Middle: arrow + processing node */}
      <div style={{ position: "absolute", left: colW - 60, top: SAFE.h / 2 - 25 }}>
        <ArrowRight width={200} progress={arrowProg} color={C.blue} />
      </div>

      <div
        style={{
          position: "absolute",
          left: colW + 160,
          top: SAFE.h / 2 - 130,
          width: 280,
          height: 260,
          background: C.accentFill,
          border: `3px solid ${C.blue}`,
          borderRadius: 32,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          opacity: procProg,
          transform: `scale(${interpolate(procProg, [0, 1], [0.85, 1])})`,
          boxShadow: `0 0 50px rgba(0,170,255,${0.22 + 0.1 * Math.sin(frame / 12)})`,
        }}
      >
        <Img src={staticFile("assets/apify/Apify Logo white Wordmark.svg")} style={{ height: 44, marginBottom: 8 }} />
        <div style={{ fontSize: 24, color: C.muted, fontWeight: 600, fontFamily: "Inter, sans-serif", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          processing
        </div>
      </div>

      <div style={{ position: "absolute", left: colW + 460, top: SAFE.h / 2 - 25 }}>
        <ArrowRight width={180} progress={arrowProg} color={C.blue} />
      </div>

      {/* Right: ranked card silhouette */}
      <div
        style={{
          position: "absolute",
          right: 60,
          top: SAFE.h / 2 - 360,
          width: colW - 100,
          background: C.cardFill,
          border: `2px solid ${C.cardBorder}`,
          borderRadius: 32,
          padding: 36,
          display: "flex",
          flexDirection: "column",
          gap: 22,
          opacity: spring({ frame, fps, delay: 40, config: SPR_BASE }),
        }}
      >
        <div style={{ fontSize: 26, color: C.muted, fontWeight: 600, fontFamily: "Inter, sans-serif", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
          ranked answers
        </div>
        {[0, 1, 2, 3].map((i) => {
          const p = spring({ frame, fps, delay: 50 + i * 8, config: SPR_BASE });
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                opacity: p,
                transform: `translateX(${interpolate(p, [0, 1], [-30, 0])}px)`,
              }}
            >
              <div style={{ width: 60, height: 60, borderRadius: "50%", background: i === 0 ? C.blue : "#2A3344", flexShrink: 0 }} />
              <div style={{ flex: 1, height: 26, background: C.skeletonBg, borderRadius: 13 }} />
            </div>
          );
        })}
      </div>

      {/* Big ? */}
      <div
        style={{
          position: "absolute",
          right: 60 + colW - 100 - 70,
          top: SAFE.h / 2 - 420,
          fontSize: 280,
          fontWeight: 900,
          color: C.blue,
          fontFamily: "Inter, sans-serif",
          lineHeight: 1,
          opacity: qProg,
          transform: `scale(${interpolate(qProg, [0, 1], [0.4, 1])})`,
          textShadow: `0 0 60px rgba(0,170,255,0.5)`,
        }}
      >
        ?
      </div>
    </div>
  );
}

// ============================================================================
// PHASE 6 — The payoff
// ============================================================================
const RANKED_ROWS = [
  { topic: "Local LLM agents for content", score: 94, value: "94" },
  { topic: "n8n × Apify pipelines",          score: 81, value: "81" },
  { topic: "Browser-use vs Playwright",      score: 72, value: "72" },
  { topic: "RAG cost benchmarking",          score: 64, value: "64" },
  { topic: "OSS automation roundup",         score: 58, value: "58" },
];

function Phase6() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const qProg = spring({ frame, fps, delay: 2, config: SPR_HERO });
  const winnerSettle = interpolate(frame, [55, 75], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cueProg = spring({ frame, fps, delay: 80, config: SPR_BASE });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Question card */}
      <div
        style={{
          position: "absolute",
          left: SAFE.w / 2 - 720,
          top: 30,
          width: 1440,
          height: 180,
          background: C.accentFill,
          border: `3px solid ${C.blue}`,
          borderRadius: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: qProg,
          transform: `translateY(${interpolate(qProg, [0, 1], [-60, 0])}px) scale(${interpolate(qProg, [0, 1], [0.85, 1])})`,
          boxShadow: `0 0 70px rgba(0,170,255,0.35)`,
        }}
      >
        <div
          style={{
            color: C.white,
            fontSize: 64,
            fontWeight: 800,
            fontFamily: "Inter, sans-serif",
            letterSpacing: "-0.015em",
          }}
        >
          What should I film next?
        </div>
      </div>

      {/* Ranked table */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 270,
          padding: "0 40px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        {RANKED_ROWS.map((row, i) => {
          const p = spring({ frame, fps, delay: 14 + i * 8, config: SPR_BASE });
          const isWinner = i === 0;
          const fillProg = interpolate(frame, [14 + i * 8 + 6, 14 + i * 8 + 26], [0, row.score / 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

          const winnerGlow = isWinner && winnerSettle > 0
            ? `0 0 ${30 + 10 * Math.sin(frame / 10)}px rgba(74,222,128,${0.3 * winnerSettle})`
            : "none";

          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 36,
                padding: "24px 36px",
                background: isWinner ? `rgba(74,222,128,${0.06 * winnerSettle})` : "transparent",
                border: `2px solid ${isWinner && winnerSettle > 0.3 ? `rgba(74,222,128,${0.7 * winnerSettle})` : C.cardBorder}`,
                borderRadius: 24,
                opacity: p,
                transform: `translateX(${interpolate(p, [0, 1], [-40, 0])}px)`,
                boxShadow: winnerGlow,
              }}
            >
              {/* Rank badge */}
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  background: isWinner && winnerSettle > 0.3 ? C.green : C.blue,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: C.white,
                  fontSize: 38,
                  fontWeight: 800,
                  fontFamily: "Inter, sans-serif",
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </div>

              {/* Topic */}
              <div
                style={{
                  flex: 1,
                  fontSize: 40,
                  color: C.white,
                  fontWeight: 600,
                  fontFamily: "Inter, sans-serif",
                  letterSpacing: "-0.01em",
                }}
              >
                {row.topic}
              </div>

              {/* Score bar */}
              <div
                style={{
                  flex: 1.2,
                  height: 60,
                  background: "#1F2535",
                  border: `1px solid ${C.cardBorder}`,
                  borderRadius: 30,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: `${fillProg * 100}%`,
                    background: isWinner && winnerSettle > 0.3
                      ? `linear-gradient(90deg, #4ADE80 0%, #6EE7A1 100%)`
                      : `linear-gradient(90deg, #00AAFF 0%, #4DC3FF 100%)`,
                    borderRadius: 30,
                  }}
                />
              </div>

              {/* Value */}
              <div
                style={{
                  width: 120,
                  textAlign: "right",
                  fontSize: 56,
                  fontWeight: 800,
                  color: isWinner && winnerSettle > 0.3 ? C.green : C.white,
                  fontFamily: "Inter, sans-serif",
                  letterSpacing: "-0.02em",
                }}
              >
                {row.value}
              </div>
            </div>
          );
        })}
      </div>

      {/* Forward cue */}
      <div
        style={{
          position: "absolute",
          right: 80,
          bottom: 40,
          display: "flex",
          alignItems: "center",
          gap: 18,
          opacity: cueProg,
          transform: `translateX(${interpolate(cueProg, [0, 1], [-20, 0])}px)`,
        }}
      >
        <div
          style={{
            color: cueProg > 0.5 ? C.blue : C.muted,
            fontSize: 28,
            fontWeight: 600,
            fontFamily: "Inter, sans-serif",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          tutorial
        </div>
        <ChevronIcon size={64} color={cueProg > 0.5 ? C.blue : C.muted} />
      </div>
    </div>
  );
}

// ============================================================================
// MAIN SCENE
// ============================================================================
export default function Scene() {
  return (
    <AbsoluteFill style={{ background: "#04101B" }}>
      <Background />
      <SafeZone>
        {/* P1 — fade-out only into P2 */}
        <Sequence from={0} durationInFrames={136} layout="none">
          <PhaseWrapper fadeIn={0} fadeOut={10} duration={136}>
            <Phase1 />
          </PhaseWrapper>
        </Sequence>

        {/* P2 — fade-in from P1; hard cut to P3 */}
        <Sequence from={126} durationInFrames={97} layout="none">
          <PhaseWrapper fadeIn={10} fadeOut={0} duration={97}>
            <Phase2 />
          </PhaseWrapper>
        </Sequence>

        {/* P3 — hard cut in from P2; fade-out to P4 */}
        <Sequence from={223} durationInFrames={71} layout="none">
          <PhaseWrapper fadeIn={0} fadeOut={10} duration={71}>
            <Phase3 />
          </PhaseWrapper>
        </Sequence>

        {/* P4 — fade-in from P3; fade-out to P5 */}
        <Sequence from={284} durationInFrames={117} layout="none">
          <PhaseWrapper fadeIn={10} fadeOut={10} duration={117}>
            <Phase4 />
          </PhaseWrapper>
        </Sequence>

        {/* P5 — fade-in from P4; fade-out to P6 */}
        <Sequence from={391} durationInFrames={156} layout="none">
          <PhaseWrapper fadeIn={10} fadeOut={10} duration={156}>
            <Phase5 />
          </PhaseWrapper>
        </Sequence>

        {/* P6 — fade-in from P5; hard cut to black */}
        <Sequence from={537} durationInFrames={95} layout="none">
          <PhaseWrapper fadeIn={10} fadeOut={0} duration={95}>
            <Phase6 />
          </PhaseWrapper>
        </Sequence>
      </SafeZone>

      {/* Closing black */}
      <Sequence from={632} durationInFrames={20} layout="none">
        <AbsoluteFill style={{ background: "#000000" }} />
      </Sequence>
    </AbsoluteFill>
  );
}
