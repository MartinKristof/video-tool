import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { evalSceneCode } from "./DynamicScene";
import { SPRINGS } from "./motion";
import { presetStyle, visibleCharacters, wordProgress } from "../lib/editor-effects";
import {
  captionPageAt,
  docDuration,
  getAsset,
  paginateCaptions,
  type Asset,
  type AudioItem,
  type CaptionsItem,
  type EditorDoc,
  type EditorItem,
  type GifItem,
  type ImageItem,
  type ItemLayout,
  type SceneItem,
  type SolidItem,
  type TextItem,
  type TextStyle,
  type VideoItem,
} from "../lib/editor-doc";

/**
 * Renders an EditorDoc. This is the ONLY place a document becomes pixels — the
 * preview player and the export both mount this component, so the preview is
 * the render rather than an approximation of it.
 *
 * Tracks stack as sibling <AbsoluteFill>s in array order, so a later track paints
 * over an earlier one. Items are positioned in time by <Sequence> and in space by
 * their layout box.
 */

/** Resolve an asset src: a project-media URL passes through, anything else is a staticFile path. */
function resolveSrc(asset: Asset): string {
  return asset.src.startsWith("/") || asset.src.startsWith("http")
    ? asset.src
    : staticFile(asset.src);
}

function layoutStyle(layout: ItemLayout): React.CSSProperties {
  return {
    position: "absolute",
    left: layout.x,
    top: layout.y,
    width: layout.width,
    height: layout.height,
    opacity: layout.opacity ?? 1,
    borderRadius: layout.cornerRadius ? layout.cornerRadius : undefined,
    overflow: layout.cornerRadius ? "hidden" : undefined,
    transform: layout.rotation ? `rotate(${layout.rotation}deg)` : undefined,
  };
}

function textStyle(style: TextStyle): React.CSSProperties {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight ?? 400,
    color: style.color,
    textAlign: style.align ?? "left",
    lineHeight: style.lineHeight ?? 1.2,
    letterSpacing: style.letterSpacing ? `${style.letterSpacing}px` : undefined,
    background: style.backgroundColor,
    padding: style.padding,
    borderRadius: style.backgroundRadius,
  };
}

/**
 * Fade a media item in and out by frame position within its own Sequence.
 * Returns 1 when no fades are set, so the common case costs nothing.
 */
function useFadeVolume(item: VideoItem | AudioItem): number {
  const frame = useCurrentFrame();
  const base = item.volume ?? 1;
  const fadeIn = item.fadeInFrames ?? 0;
  const fadeOut = item.fadeOutFrames ?? 0;
  if (!fadeIn && !fadeOut) return base;
  const dur = item.durationInFrames;
  const rampIn = fadeIn ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const rampOut = fadeOut
    ? interpolate(frame, [dur - fadeOut, dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  return base * rampIn * rampOut;
}

/**
 * Source trims are stored in SECONDS and converted here. Remotion's
 * trimBefore/trimAfter are composition frames — they are applied as a
 * `<Sequence from={-trimBefore}>` offset and the media element seeks to
 * `frame / useVideoConfig().fps`, which never consults the file's own frame
 * rate. Converting at render time keeps the document independent of fps.
 */
function trimProps(item: VideoItem | AudioItem, fps: number) {
  return {
    trimBefore: item.sourceIn != null ? Math.round(item.sourceIn * fps) : undefined,
    trimAfter: item.sourceOut != null ? Math.round(item.sourceOut * fps) : undefined,
  };
}

const VideoLayer: React.FC<{ item: VideoItem; asset?: Asset; muted: boolean }> = ({ item, asset, muted }) => {
  const { fps } = useVideoConfig();
  const volume = useFadeVolume(item);
  if (!asset) return null;
  return (
    <div style={layoutStyle(item.layout)}>
      <OffthreadVideo
        src={resolveSrc(asset)}
        {...trimProps(item, fps)}
        playbackRate={item.playbackRate ?? 1}
        volume={muted ? 0 : volume}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  );
};

const AudioLayer: React.FC<{ item: AudioItem; asset?: Asset; muted: boolean }> = ({ item, asset, muted }) => {
  const { fps } = useVideoConfig();
  const volume = useFadeVolume(item);
  if (!asset) return null;
  return (
    <Audio
      src={resolveSrc(asset)}
      {...trimProps(item, fps)}
      playbackRate={item.playbackRate ?? 1}
      volume={muted ? 0 : volume}
    />
  );
};

const ImageLayer: React.FC<{ item: ImageItem | GifItem; asset?: Asset }> = ({ item, asset }) => {
  if (!asset) return null;
  return (
    <div style={layoutStyle(item.layout)}>
      <Img
        src={resolveSrc(asset)}
        style={{ width: "100%", height: "100%", objectFit: item.fit ?? "cover" }}
      />
    </div>
  );
};

const TextLayer: React.FC<{ item: TextItem }> = ({ item }) => {
  const { inProgress } = useAnimationProgress(item);
  const preset = item.animateIn?.preset;
  const body = { ...textStyle(item.style), width: "100%", whiteSpace: "pre-wrap" as const };

  // A typewriter is per-CHARACTER — never a mask sweep with a feathered edge,
  // which reads as a wipe rather than typing.
  if (preset === "type") {
    const shown = item.text.slice(0, visibleCharacters(item.text, inProgress));
    return (
      <div style={{ ...layoutStyle(item.layout), display: "flex", alignItems: "center" }}>
        <div style={body}>{shown}</div>
      </div>
    );
  }

  if (preset === "words") {
    // Index the words up front rather than counting while rendering — a counter
    // mutated inside map() is a render-phase side effect.
    const tokens = item.text.split(/(\s+)/);
    let seen = 0;
    const indexed = tokens.map((token) => {
      const isWord = token.trim().length > 0;
      return { token, isWord, index: isWord ? seen++ : -1 };
    });
    const wordCount = seen;

    return (
      <div style={{ ...layoutStyle(item.layout), display: "flex", alignItems: "center" }}>
        <div style={body}>
          {indexed.map(({ token, isWord, index }, i) => {
            if (!isWord) return <span key={i}>{token}</span>;
            const p = wordProgress(index, wordCount, inProgress);
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  opacity: p,
                  transform: `translateY(${(1 - p) * 14}px)`,
                }}
              >
                {token}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...layoutStyle(item.layout), display: "flex", alignItems: "center" }}>
      <div style={body}>{item.text}</div>
    </div>
  );
};

const SolidLayer: React.FC<{ item: SolidItem }> = ({ item }) => (
  <div style={{ ...layoutStyle(item.layout), background: item.color }} />
);

/**
 * Captions show a page of words at a time, highlighting the one being spoken.
 *
 * `useCurrentFrame()` inside a <Sequence> is already item-relative, and caption
 * token times are item-relative too, so the two line up with no offset maths —
 * which is what keeps captions in sync when the item is dragged or trimmed.
 */
const CaptionsLayer: React.FC<{ item: CaptionsItem }> = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pages = useMemo(
    () => paginateCaptions(item.tokens, item.pageDurationMs ?? 1200, item.maxWordsPerPage ?? 6),
    [item.tokens, item.pageDurationMs, item.maxWordsPerPage],
  );
  const sec = frame / fps;
  const page = captionPageAt(pages, sec);
  if (!page) return null;
  return (
    <div style={{ ...layoutStyle(item.layout), display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ ...textStyle(item.style), textAlign: "center" }}>
        {page.tokens.map((w, i) => {
          const active = sec >= w.startSec && sec < w.endSec;
          return (
            <span
              key={i}
              style={{ color: active ? item.highlightColor ?? item.style.color : item.style.color }}
            >
              {w.text}
              {i < page.tokens.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/**
 * An AI-generated scene, placed as an item. Compiling TSX is expensive, so the
 * component is memoised on the code itself — without that, a document holding a
 * few generated scenes would recompile all of them on every frame.
 */
const SceneLayer: React.FC<{ item: SceneItem }> = ({ item }) => {
  const Component = useMemo(() => evalSceneCode(item.code)?.component ?? null, [item.code]);
  if (!Component) return null;
  const offset = item.sourceOffsetFrames ?? 0;
  const scene = <Component />;
  return (
    <div style={layoutStyle(item.layout)}>
      {offset > 0 ? (
        // Shift the embedded composition back so this item shows the stretch
        // starting at `offset` — the same mechanism Remotion uses for trimBefore.
        // A generated edit can then be split into blocks with its animated cards
        // still rendering exactly as authored.
        <Sequence from={-offset} layout="none">
          {scene}
        </Sequence>
      ) : (
        scene
      )}
    </div>
  );
};

/**
 * Progress of an item's in and out animations at the current frame, using the
 * house springs so an editor animation matches a generated one.
 *
 * Returned as a pair because opacity takes the MINIMUM of the two — the idiom
 * the branded scenes use for an element that arrives and later leaves.
 */
function useAnimationProgress(item: EditorItem) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const inSpec = item.animateIn;
  const outSpec = item.animateOut;
  // `durationInFrames` stretches the spring to the requested length. Driving it
  // with a plain delayed spring instead — as this first did — ignores the field
  // entirely, because a spring's length comes from its config, so changing the
  // number in Properties did nothing.
  const inProgress = inSpec && inSpec.preset !== "none"
    ? spring({
        frame,
        fps,
        config: SPRINGS.SNAPPY,
        durationInFrames: Math.max(1, inSpec.durationInFrames),
      })
    : 1;
  const outProgress = outSpec && outSpec.preset !== "none"
    ? interpolate(
        frame,
        [item.durationInFrames - outSpec.durationInFrames, item.durationInFrames],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      )
    : 1;
  return { inProgress, outProgress };
}

/**
 * Wraps a layer in its in/out animation. Transform-only presets are applied
 * here; `type` and `words` decompose the text itself and are handled by the
 * text layer, so this stays neutral for them.
 */
const Animated: React.FC<{ item: EditorItem; children: React.ReactNode }> = ({ item, children }) => {
  const { inProgress, outProgress } = useAnimationProgress(item);
  if (!item.animateIn && !item.animateOut) return <>{children}</>;

  const enter = presetStyle(item.animateIn?.preset ?? "none", inProgress, "in");
  const leave = presetStyle(item.animateOut?.preset ?? "none", outProgress, "out");
  const transforms = [enter.transform, leave.transform].filter((t) => t !== "none");

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: Math.min(enter.opacity, leave.opacity),
        transform: transforms.length > 0 ? transforms.join(" ") : undefined,
      }}
    >
      {children}
    </div>
  );
};

const ItemLayer: React.FC<{ item: EditorItem; doc: EditorDoc; muted: boolean }> = ({ item, doc, muted }) => {
  switch (item.type) {
    case "video":
      return <VideoLayer item={item} asset={getAsset(doc, item.assetId)} muted={muted} />;
    case "audio":
      return <AudioLayer item={item} asset={getAsset(doc, item.assetId)} muted={muted} />;
    case "image":
    case "gif":
      return <ImageLayer item={item} asset={getAsset(doc, item.assetId)} />;
    case "text":
      return <TextLayer item={item} />;
    case "solid":
      return <SolidLayer item={item} />;
    case "captions":
      return <CaptionsLayer item={item} />;
    case "scene":
      return <SceneLayer item={item} />;
  }
};

export const EditorComposition: React.FC<{ doc: EditorDoc }> = ({ doc }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {doc.tracks.map((track) =>
        track.hidden ? null : (
          <AbsoluteFill key={track.id}>
            {track.items.map((item) => (
              <Sequence
                key={item.id}
                from={item.from}
                durationInFrames={item.durationInFrames}
                layout="none"
                name={`${item.type}:${item.id}`}
              >
                  <Animated item={item}>
                  <ItemLayer item={item} doc={doc} muted={Boolean(track.muted)} />
                </Animated>
              </Sequence>
            ))}
          </AbsoluteFill>
        ),
      )}
    </AbsoluteFill>
  );
};

/** Duration helper so the Player and the render entry agree on length. */
export function editorDocDuration(doc: EditorDoc): number {
  return docDuration(doc);
}

export default EditorComposition;
