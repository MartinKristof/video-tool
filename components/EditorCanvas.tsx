"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { itemsAtFrame, resizeLayout, setLayout, snapBox, type EditorDoc, type EditorItem, type ItemLayout, type ResizeHandle } from "@/lib/editor-doc";

/**
 * Direct manipulation over the preview: click to select, drag to move, handles
 * to resize.
 *
 * The overlay is laid out in SCREEN pixels but every value it writes is in
 * COMPOSITION pixels, so an edit means the same thing whatever size the preview
 * happens to be. The pointer handling follows the pattern already proven by the
 * terminal zoom tool (components/TerminalPreview.tsx): listeners are attached in
 * the capture phase and swallow click/dragstart, otherwise the Player's own
 * control bar eats the gesture.
 *
 * Only items visible at the current frame are interactive — you can't drag
 * something that isn't on screen.
 */

type Handle = ResizeHandle;

interface DragState {
  itemId: string;
  handle: Handle | null; // null = move
  startX: number;
  startY: number;
  origin: ItemLayout;
  scale: number; // screen px per composition px
}

const HANDLES: { id: Handle; x: number; y: number; cursor: string }[] = [
  { id: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { id: "n", x: 0.5, y: 0, cursor: "ns-resize" },
  { id: "ne", x: 1, y: 0, cursor: "nesw-resize" },
  { id: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { id: "se", x: 1, y: 1, cursor: "nwse-resize" },
  { id: "s", x: 0.5, y: 1, cursor: "ns-resize" },
  { id: "sw", x: 0, y: 1, cursor: "nesw-resize" },
  { id: "w", x: 0, y: 0.5, cursor: "ew-resize" },
];

export default function EditorCanvas({
  doc, currentFrame, selectedIds, onSelectionChange, onChange, boxW, boxH,
}: {
  doc: EditorDoc;
  currentFrame: number;
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  onChange: (next: EditorDoc) => void;
  /** Size of the rendered video box, in screen pixels. */
  boxW: number;
  boxH: number;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<ItemLayout | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef<{ layout: ItemLayout | null; itemId: string | null }>({ layout: null, itemId: null });

  const scale = boxW / doc.size.width;
  const visible = useMemo(() => itemsAtFrame(doc, currentFrame), [doc, currentFrame]);

  const begin = useCallback((e: React.PointerEvent, item: EditorItem, handle: Handle | null) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectionChange(e.shiftKey || e.metaKey || e.ctrlKey
      ? new Set([...selectedIds, item.id])
      : new Set([item.id]));
    latest.current = { layout: item.layout, itemId: item.id };
    setPreview(item.layout);
    setDrag({ itemId: item.id, handle, startX: e.clientX, startY: e.clientY, origin: item.layout, scale });
  }, [scale, selectedIds, onSelectionChange]);

  useEffect(() => {
    if (!drag) return;
    const s = drag;

    function onMove(e: PointerEvent) {
      const dxComp = (e.clientX - s.startX) / s.scale;
      const dyComp = (e.clientY - s.startY) / s.scale;
      const tol = 8 / s.scale;
      let next: ItemLayout = { ...s.origin };
      let gx: number | null = null;
      let gy: number | null = null;

      if (s.handle === null) {
        // Shift locks movement to whichever axis you have moved furthest along.
        let dx = dxComp;
        let dy = dyComp;
        if (e.shiftKey) {
          if (Math.abs(dxComp) > Math.abs(dyComp)) dy = 0; else dx = 0;
        }
        const snapped = snapBox(
          s.origin.x + dx, s.origin.y + dy, s.origin.width, s.origin.height, doc.size, tol,
        );
        gx = snapped.guideX;
        gy = snapped.guideY;
        next = { ...s.origin, x: Math.round(snapped.x), y: Math.round(snapped.y) };
      } else {
        next = resizeLayout(s.origin, s.handle, dxComp, dyComp);
      }

      latest.current = { layout: next, itemId: s.itemId };
      setPreview(next);
      setGuides({ x: gx, y: gy });
    }

    function onUp() {
      const { layout, itemId } = latest.current;
      setDrag(null);
      setPreview(null);
      setGuides({ x: null, y: null });
      if (layout && itemId) onChange(setLayout(doc, itemId, layout));
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, doc, onChange]);

  // The Player's controls sit under this overlay and would otherwise claim the
  // gesture; swallow the events it reacts to while a drag is in progress.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const swallow = (e: Event) => { if (drag) { e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener("click", swallow, true);
    el.addEventListener("dragstart", swallow, true);
    return () => {
      el.removeEventListener("click", swallow, true);
      el.removeEventListener("dragstart", swallow, true);
    };
  }, [drag]);

  const toScreen = (l: ItemLayout) => ({
    left: l.x * scale,
    top: l.y * scale,
    width: l.width * scale,
    height: l.height * scale,
  });

  return (
    <div
      ref={rootRef}
      onPointerDown={() => onSelectionChange(new Set())}
      style={{ position: "absolute", left: 0, top: 0, width: boxW, height: boxH, zIndex: 3 }}
    >
      {visible.map((item) => {
        const selected = selectedIds.has(item.id);
        const layout = drag?.itemId === item.id && preview ? preview : item.layout;
        const box = toScreen(layout);
        return (
          <div
            key={item.id}
            onPointerDown={(e) => begin(e, item, null)}
            style={{
              position: "absolute", ...box, cursor: "move",
              outline: selected ? "1.5px solid var(--accent)" : "1px dashed rgba(255,255,255,0.25)",
              outlineOffset: 0,
              background: "transparent",
            }}
          >
            {selected && HANDLES.map((h) => (
              <div
                key={h.id}
                onPointerDown={(e) => begin(e, item, h.id)}
                style={{
                  position: "absolute",
                  left: `calc(${h.x * 100}% - 4px)`,
                  top: `calc(${h.y * 100}% - 4px)`,
                  width: 8, height: 8, borderRadius: 2,
                  background: "var(--accent)", border: "1px solid #fff",
                  cursor: h.cursor,
                }}
              />
            ))}
          </div>
        );
      })}

      {guides.x != null && (
        <div style={{ position: "absolute", left: guides.x * scale, top: 0, bottom: 0, width: 1, background: "var(--accent)", opacity: 0.8, pointerEvents: "none" }} />
      )}
      {guides.y != null && (
        <div style={{ position: "absolute", top: guides.y * scale, left: 0, right: 0, height: 1, background: "var(--accent)", opacity: 0.8, pointerEvents: "none" }} />
      )}
    </div>
  );
}
