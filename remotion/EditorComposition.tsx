import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { evalSceneCode } from "./DynamicScene";
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

const TextLayer: React.FC<{ item: TextItem }> = ({ item }) => (
  <div style={{ ...layoutStyle(item.layout), display: "flex", alignItems: "center" }}>
    <div style={{ ...textStyle(item.style), width: "100%", whiteSpace: "pre-wrap" }}>{item.text}</div>
  </div>
);

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
                <ItemLayer item={item} doc={doc} muted={Boolean(track.muted)} />
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
