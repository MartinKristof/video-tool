import React from "react";
import {
  AbsoluteFill,
  Video,
  Sequence,
  Freeze,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { BRAND, BRAND_FONT_FACE_CSS } from "../../theme";

// Apple-style: snap into zoom quickly, drift back out slowly.
const RAMP_IN_FRAMES = 8;
const RAMP_OUT_FRAMES = 24;
export const DEFAULT_RAMP_IN_FRAMES = RAMP_IN_FRAMES;
export const DEFAULT_RAMP_OUT_FRAMES = RAMP_OUT_FRAMES;
export const END_CARD_FRAMES = 120;

// expo-out: fast start, smooth settle.
const EASE_IN = Easing.bezier(0.16, 1, 0.3, 1);
// smooth symmetric ease for the drift back to neutral.
const EASE_OUT = Easing.bezier(0.4, 0, 0.6, 1);

type ZoomEasing = "snap" | "smooth" | "linear";

// Resolve a per-zoom easing preset into [in, out] bezier/linear functions.
function easingPair(name: ZoomEasing | undefined): {
  ease: (t: number) => number;
  out: (t: number) => number;
} {
  switch (name) {
    case "smooth": {
      const css = Easing.bezier(0.25, 0.1, 0.25, 1);
      return { ease: css, out: css };
    }
    case "linear":
      return { ease: Easing.linear, out: Easing.linear };
    case "snap":
    default:
      return { ease: EASE_IN, out: EASE_OUT };
  }
}

interface FreezeT {
  id: string;
  atCompFrame: number;
  durationFrames: number;
}

export interface TerminalRecordingProps {
  videoSrc: string;
  annotations: {
    videoDurationFrames: number;
    zooms: Array<{
      id: string;
      startFrame: number;
      endFrame: number;
      rect: { x: number; y: number; w: number; h: number };
      rampInFrames?: number;
      rampOutFrames?: number;
      easing?: ZoomEasing;
    }>;
    freezes?: FreezeT[];
    banner?: {
      text: string;
      subtitle?: string;
      startFrame: number;
      endFrame: number;
    };
    endCard?: { title: string; subtitle?: string; url?: string; startFrame?: number };
  };
}

function totalFreezeFrames(freezes?: FreezeT[]): number {
  if (!freezes) return 0;
  return freezes.reduce((sum, f) => sum + f.durationFrames, 0);
}

export function terminalTotalFrames(a: TerminalRecordingProps["annotations"]): number {
  const videoPortion = a.videoDurationFrames + totalFreezeFrames(a.freezes);
  if (!a.endCard) return videoPortion;
  const endStart = a.endCard.startFrame ?? videoPortion;
  return Math.max(videoPortion, endStart + END_CARD_FRAMES);
}

// Expand the user-drawn rect to match the composition's aspect ratio while
// keeping the original center. In normalized coords (x/w against compWidth,
// y/h against compHeight) the rect matches the composition aspect when
// w === h, so we use max(w, h) for both and clamp inside [0,1].
export function normalizeRectToCompAspect(rect: { x: number; y: number; w: number; h: number }) {
  const target = Math.max(rect.w, rect.h);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const x = Math.max(0, Math.min(1 - target, cx - target / 2));
  const y = Math.max(0, Math.min(1 - target, cy - target / 2));
  return { x, y, w: target, h: target };
}

function computeZoom(
  rect: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
) {
  const r = normalizeRectToCompAspect(rect);
  const safeW = Math.max(r.w, 0.05);
  const s = 1 / safeW;
  const cx = (r.x + r.w / 2) * width;
  const cy = (r.y + r.h / 2) * height;
  const tx = width / 2 - cx * s;
  const ty = height / 2 - cy * s;
  return { s, tx, ty };
}

const VideoTrack: React.FC<{
  videoSrc: string;
  freezes: FreezeT[];
  videoDurationFrames: number;
}> = ({ videoSrc, freezes, videoDurationFrames }) => {
  const sorted = [...freezes].sort((a, b) => a.atCompFrame - b.atCompFrame);
  const elements: React.ReactNode[] = [];
  let v = 0; // video frame cursor
  let c = 0; // composition frame cursor
  const videoStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain" };
  for (const fr of sorted) {
    const normalDur = Math.max(0, fr.atCompFrame - c);
    if (normalDur > 0) {
      elements.push(
        <Sequence key={`n-${c}`} from={c} durationInFrames={normalDur}>
          <Video src={videoSrc} trimBefore={v} trimAfter={v + normalDur} style={videoStyle} />
        </Sequence>,
      );
      v += normalDur;
      c += normalDur;
    }
    elements.push(
      <Sequence key={`f-${fr.id}`} from={c} durationInFrames={fr.durationFrames}>
        <Freeze frame={v}>
          <Video src={videoSrc} style={videoStyle} />
        </Freeze>
      </Sequence>,
    );
    c += fr.durationFrames;
  }
  const remaining = Math.max(0, videoDurationFrames - v);
  if (remaining > 0) {
    elements.push(
      <Sequence key="n-end" from={c} durationInFrames={remaining}>
        <Video src={videoSrc} trimBefore={v} style={videoStyle} />
      </Sequence>,
    );
  }
  if (elements.length === 0) {
    elements.push(<Video key="full" src={videoSrc} style={videoStyle} />);
  }
  return <>{elements}</>;
};

const ZoomedVideo: React.FC<{
  videoSrc: string;
  zooms: TerminalRecordingProps["annotations"]["zooms"];
  freezes: FreezeT[];
  videoDurationFrames: number;
}> = ({ videoSrc, zooms, freezes, videoDurationFrames }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // For overlap detection we need each zoom's own ramp window, not the global
  // defaults — a zoom with a longer ramp-in must "claim" the frame earlier.
  const active = zooms.find((z) => {
    const rin = Math.max(0, z.rampInFrames ?? RAMP_IN_FRAMES);
    const rout = Math.max(0, z.rampOutFrames ?? RAMP_OUT_FRAMES);
    return frame >= z.startFrame - rin && frame <= z.endFrame + rout;
  });

  let transform = "";
  if (active) {
    const rin = Math.max(0, active.rampInFrames ?? RAMP_IN_FRAMES);
    const rout = Math.max(0, active.rampOutFrames ?? RAMP_OUT_FRAMES);
    const { ease: easeIn, out: easeOut } = easingPair(active.easing);
    const { s, tx, ty } = computeZoom(active.rect, width, height);
    const inP = interpolate(
      frame,
      [active.startFrame - rin, active.startFrame],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeIn },
    );
    const outP = interpolate(
      frame,
      [active.endFrame, active.endFrame + rout],
      [1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut },
    );
    const progress = Math.min(inP, outP);
    const liveS = 1 + (s - 1) * progress;
    const liveTx = tx * progress;
    const liveTy = ty * progress;
    transform = `translate(${liveTx}px, ${liveTy}px) scale(${liveS})`;
  }

  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#161718" }}>
      <div
        style={{
          width,
          height,
          transformOrigin: "0 0",
          transform,
        }}
      >
        <VideoTrack videoSrc={videoSrc} freezes={freezes} videoDurationFrames={videoDurationFrames} />
      </div>
    </AbsoluteFill>
  );
};

const BannerOverlay: React.FC<{
  text: string;
  subtitle?: string;
  durationInFrames: number;
}> = ({ text, subtitle, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const barIn = spring({ frame, fps, delay: 0, config: { damping: 200 } });
  const titleIn = spring({ frame, fps, delay: 6, config: { damping: 200 } });
  const subIn = spring({ frame, fps, delay: 12, config: { damping: 200 } });

  const exitStart = Math.max(0, durationInFrames - 12);
  const exitProgress = interpolate(frame, [exitStart, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = Math.min(barIn, 1 - exitProgress);
  const slideY =
    interpolate(barIn, [0, 1], [-base * 0.05, 0]) +
    interpolate(exitProgress, [0, 1], [0, -base * 0.04]);

  return (
    <AbsoluteFill style={{ background: "transparent" }}>
      <style>{BRAND_FONT_FACE_CSS}</style>
      <div
        style={{
          position: "absolute",
          top: base * 0.06,
          left: width * 0.06,
          right: width * 0.06,
          display: "flex",
          flexDirection: "column",
          gap: base * 0.014,
          opacity,
          transform: `translateY(${slideY}px)`,
          padding: `${base * 0.022}px ${base * 0.034}px`,
          background: BRAND.colors.bg,
          borderRadius: base * 0.012,
          boxShadow: `0 ${base * 0.012}px ${base * 0.04}px rgba(0,0,0,0.55)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: base * 0.012,
            opacity: titleIn,
            transform: `translateX(${interpolate(titleIn, [0, 1], [-12, 0])}px)`,
          }}
        >
          <div
            style={{
              width: Math.max(3, base * 0.004),
              height: base * 0.045,
              background: BRAND.colors.orange,
              borderRadius: 2,
            }}
          />
          <div
            style={{
              fontFamily: BRAND.fonts.marketing,
              fontWeight: 700,
              fontSize: base * 0.045,
              color: BRAND.colors.text,
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            {text}
          </div>
        </div>
        {subtitle && (
          <div
            style={{
              fontFamily: BRAND.fonts.primary,
              fontWeight: 500,
              fontSize: base * 0.022,
              color: BRAND.colors.textMuted,
              lineHeight: 1.3,
              opacity: subIn,
              transform: `translateY(${interpolate(subIn, [0, 1], [10, 0])}px)`,
              paddingLeft: base * 0.016,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

const EndCardOverlay: React.FC<{ title: string; subtitle?: string; url?: string }> = ({
  title,
  subtitle,
  url,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const base = Math.min(width, height);

  const titleIn = spring({ frame, fps, delay: 0, config: { damping: 200 } });
  const subIn = spring({ frame, fps, delay: 8, config: { damping: 200 } });
  const urlIn = spring({ frame, fps, delay: 16, config: { damping: 200 } });
  const breathe = 1 + Math.sin((frame - 30) / 22) * 0.015;

  const displayUrl = url
    ? /^https?:\/\//i.test(url)
      ? url
      : url.startsWith("www.") ? url : `www.${url}`
    : null;

  return (
    <AbsoluteFill
      style={{
        background: "#161718",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: base * 0.032,
      }}
    >
      <div
        style={{
          fontFamily: "Inter, sans-serif",
          fontWeight: 700,
          fontSize: base * 0.072,
          color: "#FFFFFF",
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
          textAlign: "center",
          maxWidth: width * 0.75,
          opacity: titleIn,
          transform: `translateY(${interpolate(titleIn, [0, 1], [24, 0])}px) scale(${breathe})`,
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          style={{
            fontFamily: "Inter, sans-serif",
            fontWeight: 400,
            fontSize: base * 0.026,
            color: "rgba(255,255,255,0.6)",
            textAlign: "center",
            maxWidth: width * 0.65,
            opacity: subIn,
            transform: `translateY(${interpolate(subIn, [0, 1], [14, 0])}px)`,
          }}
        >
          {subtitle}
        </div>
      )}
      {displayUrl && (
        <div
          style={{
            fontFamily: "Inter, sans-serif",
            fontWeight: 500,
            fontSize: base * 0.026,
            color: "rgba(255,255,255,0.5)",
            letterSpacing: "0.01em",
            opacity: urlIn,
            transform: `translateY(${interpolate(urlIn, [0, 1], [14, 0])}px)`,
          }}
        >
          {displayUrl}
        </div>
      )}
    </AbsoluteFill>
  );
};

const TerminalRecording: React.FC<TerminalRecordingProps> = ({ videoSrc, annotations }) => {
  const banner = annotations.banner;
  const freezes = annotations.freezes ?? [];
  const videoPortion = annotations.videoDurationFrames + totalFreezeFrames(freezes);
  const endCardStart = annotations.endCard?.startFrame ?? videoPortion;
  return (
    <AbsoluteFill style={{ background: "#161718" }}>
      <Sequence durationInFrames={videoPortion}>
        <ZoomedVideo
          videoSrc={videoSrc}
          zooms={annotations.zooms}
          freezes={freezes}
          videoDurationFrames={annotations.videoDurationFrames}
        />
        {banner && (
          <Sequence
            from={banner.startFrame}
            durationInFrames={Math.max(1, banner.endFrame - banner.startFrame)}
          >
            <BannerOverlay
              text={banner.text}
              subtitle={banner.subtitle}
              durationInFrames={Math.max(1, banner.endFrame - banner.startFrame)}
            />
          </Sequence>
        )}
      </Sequence>
      {annotations.endCard && (
        <Sequence from={endCardStart} durationInFrames={END_CARD_FRAMES}>
          <EndCardOverlay
            title={annotations.endCard.title}
            subtitle={annotations.endCard.subtitle}
            url={annotations.endCard.url}
          />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

export default TerminalRecording;
