"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { AbsoluteFill } from "remotion";
import { EditorComposition } from "@/remotion/EditorComposition";
import EditorCanvas from "@/components/EditorCanvas";
import { docDuration, type EditorDoc } from "@/lib/editor-doc";

/**
 * Preview for a document-based project. Mounts the SAME component the export
 * uses (`EditorComposition`), so the preview is the render rather than an
 * approximation of it.
 *
 * `playerRef` is a prop, not a forwarded ref: this component is loaded with
 * `next/dynamic({ ssr: false })` and a forwarded ref would be lost — the same
 * reason PreviewPanel takes it as a prop.
 */
export default function EditorPreview({
  doc,
  playerRef,
  currentFrame = 0,
  selectedIds,
  onSelectionChange,
  onChange,
}: {
  doc: EditorDoc;
  playerRef?: React.RefObject<PlayerRef | null>;
  currentFrame?: number;
  selectedIds?: Set<string>;
  onSelectionChange?: (next: Set<string>) => void;
  onChange?: (next: EditorDoc) => void;
}) {
  const durationInFrames = useMemo(() => docDuration(doc), [doc]);
  const inputProps = useMemo(() => ({ doc }), [doc]);
  const { width, height, fps } = doc.size;
  const isEmpty = doc.tracks.every((t) => t.items.length === 0);

  // The overlay has to sit exactly on the rendered video, so measure the largest
  // rect that keeps the composition's aspect ratio and fits the available area.
  // CSS `aspect-ratio` alone doesn't do this reliably when both dimensions are
  // constrained — the same reason TerminalPreview measures it by hand.
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ratio = width / height;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      setBox(r.width / r.height > ratio
        ? { w: Math.round(r.height * ratio), h: Math.round(r.height) }
        : { w: Math.round(r.width), h: Math.round(r.width / ratio) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  const canEdit = Boolean(onChange && onSelectionChange && selectedIds);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      <div
        className="mono nums"
        style={{
          position: "absolute", top: 12, left: 12, zIndex: 2, padding: "4px 8px",
          background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", fontSize: 10,
          color: "rgba(255,255,255,0.75)", borderRadius: 3, border: "0.5px solid rgba(255,255,255,0.1)",
        }}
      >
        {durationInFrames}F / {fps}FPS / {(durationInFrames / fps).toFixed(1)}S
      </div>

      <div ref={boxRef} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", padding: 2, minHeight: 0, position: "relative" }}>
        <div style={{ position: "relative", width: box.w || "100%", height: box.h || undefined }}>
        <Player
          ref={playerRef}
          component={EditorComposition}
          inputProps={inputProps}
          compositionWidth={width}
          compositionHeight={height}
          durationInFrames={durationInFrames}
          fps={fps}
          style={{ width: "100%", height: "100%" }}
          controls
          loop
          errorFallback={({ error }) => (
            <AbsoluteFill style={{ backgroundColor: "#040D12", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
              <div style={{ color: "#f87171", fontSize: 28, textAlign: "center", fontFamily: "sans-serif" }}>
                <div style={{ marginBottom: 12 }}>Render error</div>
                <div style={{ color: "var(--text-2)", fontSize: 20 }}>{error.message}</div>
              </div>
            </AbsoluteFill>
          )}
        />
        {canEdit && box.w > 0 && (
          <EditorCanvas
            doc={doc}
            currentFrame={currentFrame}
            selectedIds={selectedIds!}
            onSelectionChange={onSelectionChange!}
            onChange={onChange!}
            boxW={box.w}
            boxH={box.h}
          />
        )}
        </div>
      </div>

      {isEmpty && (
        <div
          style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none", color: "var(--text-2)", fontSize: 13,
          }}
        >
          Drop a clip onto a track to start
        </div>
      )}
    </div>
  );
}
