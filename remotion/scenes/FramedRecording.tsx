import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  staticFile,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
  Easing,
} from "remotion";
import { BRAND } from "../theme";

// --- Animated dot-grid background (ported from the "Background dots pop-in"
// project): dots scale up in a diagonal staggered wave, then hold. ---
const DOT_COLOR = "#F86606";
const VB_WIDTH = 3846;
const VB_HEIGHT = 2459;
const TILE_W = 269.64;
const TILE_H = 224.7;
const SCALE = 3.21;
const DOT_OFFSETS_PATTERN: Array<[number, number]> = [
  [7, 7], [7, 30], [7, 52],
  [36, 7], [36, 30], [36, 52],
  [65, 7], [65, 30], [65, 52],
];
const DOTS: Array<{ x: number; y: number }> = (() => {
  const out: Array<{ x: number; y: number }> = [];
  const cols = Math.ceil(VB_WIDTH / TILE_W) + 1;
  const rows = Math.ceil(VB_HEIGHT / TILE_H) + 1;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      for (const [px, py] of DOT_OFFSETS_PATTERN) {
        const x = tx * TILE_W + px * SCALE;
        const y = ty * TILE_H + py * SCALE;
        if (x < 0 || x > VB_WIDTH || y < 0 || y > VB_HEIGHT) continue;
        out.push({ x, y });
      }
    }
  }
  return out;
})();
const DIAG_MAX = VB_WIDTH + VB_HEIGHT;
const STAGGER_FRAMES = 45;
const POP_FRAMES = 22;
const DECELERATE = Easing.out(Easing.exp);

const BackgroundDots: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: BRAND.colors.bg }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`}
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        {DOTS.map((d, i) => {
          const delay = ((d.x + d.y) / DIAG_MAX) * STAGGER_FRAMES;
          const scale = interpolate(frame - delay, [0, POP_FRAMES], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: DECELERATE,
          });
          return <circle key={i} cx={d.x} cy={d.y} r={SCALE * scale} fill={DOT_COLOR} />;
        })}
      </svg>
    </AbsoluteFill>
  );
};

// Channel-ready framing for the Brand Deal Spy screen recording: the raw
// capture sits in a rounded, shadowed panel over the animated dot-grid
// background — filling a clean 16:9 frame, recording pixels untouched.
export type FramedRecordingProps = {
  videoSrc: string; // staticFile() path to the recording
  aspect: number; // recording width / height
  heightFraction?: number; // panel height as a fraction of canvas height
  showLogo?: boolean;
};

const FramedRecording: React.FC<FramedRecordingProps> = ({
  videoSrc,
  aspect,
  heightFraction = 0.9,
  showLogo = false,
}) => {
  const { width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const panelH = height * heightFraction;
  const panelW = panelH * aspect;
  const radius = base * 0.018;

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND.colors.bg }}>
      <BackgroundDots />

      {/* Soft orange glow for depth */}
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: panelW * 1.15,
            height: panelH * 1.15,
            background: `radial-gradient(ellipse at center, ${BRAND.colors.orange}26 0%, rgba(0,0,0,0) 68%)`,
            filter: `blur(${base * 0.03}px)`,
          }}
        />
      </AbsoluteFill>

      {/* Recording in a rounded, shadowed panel */}
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: panelW,
            height: panelH,
            borderRadius: radius,
            overflow: "hidden",
            backgroundColor: BRAND.colors.card,
            border: `1px solid rgba(255,255,255,0.08)`,
            boxShadow: `0 ${base * 0.038}px ${base * 0.11}px rgba(0,0,0,0.65), 0 ${base * 0.008}px ${base * 0.022}px rgba(0,0,0,0.45)`,
          }}
        >
          <OffthreadVideo
            src={videoSrc}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
      </AbsoluteFill>

      {showLogo && (
        <Img
          src={staticFile("assets/logos/Brand.svg")}
          style={{
            position: "absolute",
            bottom: base * 0.04,
            left: base * 0.045,
            height: base * 0.03,
            opacity: 0.85,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default FramedRecording;
