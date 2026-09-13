"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import { snapFrame } from "@/lib/editable-timeline";
import {
  addItem, addTrack, docDuration, getAsset, makeId, moveItem, removeItem,
  removeTrack, rippleRemoveItem, snapTargets, splitItem, trimItem,
  type Asset, type EditorDoc, type EditorItem, type Track,
} from "@/lib/editor-doc";

/**
 * Timeline for a document-based project.
 *
 * Geometry, zoom, snapping and the keyboard map deliberately mirror
 * components/Timeline.tsx so the two editors feel the same. What differs is the
 * edit layer: every change here is a pure function over the document, so there
 * is no code to parse, no shape to refuse, and no read-only state to fall into.
 */

const LABEL_W = 104;
const RULER_H = 22;
const TRACK_H = 44;
const SNAP_PX = 8;
const MAX_PX_PER_FRAME = 16;

type DragMode = "move" | "trim-left" | "trim-right";

interface DragState {
  itemId: string;
  mode: DragMode;
  originalFrom: number;
  originalDuration: number;
  startX: number;
  pxPerFrame: number;
  deltaFrames: number;
  targets: number[];
  snap: boolean;
}

export interface MediaFile {
  name: string;
  path: string;
  type: string;
}

interface Props {
  doc: EditorDoc;
  onChange: (next: EditorDoc) => void;
  currentFrame: number;
  onSeek?: (frame: number) => void;
  onScrubStart?: () => void;
  onTogglePlay?: () => void;
  /** Files in the project's media folder, offered by the insert picker. */
  mediaFiles?: MediaFile[];
  /** Source durations in seconds, keyed by the same `path` as mediaFiles. */
  mediaDurations?: Record<string, number>;
  projectId?: string;
  /** Selection is shared with the canvas, so it lives above both of them. */
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}

const ITEM_COLORS: Record<string, string> = {
  video: "oklch(0.72 0.26 340)",
  audio: "oklch(0.78 0.18 160)",
  image: "oklch(0.82 0.14 210)",
  gif: "oklch(0.82 0.14 210)",
  text: "oklch(0.82 0.16 75)",
  solid: "oklch(0.72 0.20 280)",
  captions: "oklch(0.88 0.22 124)",
  scene: "oklch(0.82 0.16 75)",
};

const ITEM_ICONS: Record<string, string> = {
  video: "film", audio: "monitor", image: "layers", gif: "layers",
  text: "layers", solid: "layers", captions: "layers", scene: "layers",
};

export default function DocTimeline({
  doc, onChange, currentFrame, onSeek, onScrubStart, onTogglePlay,
  mediaFiles, mediaDurations, projectId, selectedIds, onSelectionChange,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const [containerWidth, setContainerWidth] = useState(900);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [captionsBusy, setCaptionsBusy] = useState<string | null>(null);
  const deltaRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { fps } = doc.size;
  const total = Math.max(1, docDuration(doc));

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const trackW = Math.max(120, containerWidth - LABEL_W - 8);
  const fitPx = trackW / total;
  const maxZoom = Math.max(2, Math.min(300, MAX_PX_PER_FRAME / Math.max(fitPx, 0.0001)));
  const pxPerFrame = fitPx * Math.min(zoom, maxZoom);
  const contentW = total * pxPerFrame;

  const commit = useCallback((next: EditorDoc) => onChange(next), [onChange]);

  // ── selection ─────────────────────────────────────────────────────────────
  const selectItem = useCallback((id: string, additive: boolean) => {
    if (!additive) { onSelectionChange(new Set([id])); return; }
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectionChange(next);
  }, [selectedIds, onSelectionChange]);
  const deselect = useCallback(() => onSelectionChange(new Set()), [onSelectionChange]);

  // ── scrubbing ─────────────────────────────────────────────────────────────
  const frameFromClientX = useCallback((clientX: number) => {
    const el = rulerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
    return Math.max(0, Math.min(total - 1, Math.round(x / pxPerFrame)));
  }, [pxPerFrame, total]);

  const startScrub = useCallback((e: React.PointerEvent) => {
    onScrubStart?.();
    onSeek?.(frameFromClientX(e.clientX));
    const move = (ev: PointerEvent) => onSeek?.(frameFromClientX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [frameFromClientX, onSeek, onScrubStart]);

  // ── dragging items ────────────────────────────────────────────────────────
  const beginDrag = useCallback((e: React.PointerEvent, item: EditorItem, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    selectItem(item.id, e.shiftKey || e.metaKey || e.ctrlKey);
    deltaRef.current = 0;
    setDragState({
      itemId: item.id,
      mode,
      originalFrom: item.from,
      originalDuration: item.durationInFrames,
      startX: e.clientX,
      pxPerFrame,
      deltaFrames: 0,
      targets: snapTargets(doc, { excludeItemId: item.id, playhead: currentFrame }),
      snap: snapOn,
    });
  }, [doc, currentFrame, pxPerFrame, snapOn, selectItem]);

  useEffect(() => {
    if (!dragState) return;
    const s = dragState;
    function onMove(e: PointerEvent) {
      const raw = Math.round((e.clientX - s.startX) / s.pxPerFrame);
      let delta = raw;
      let snapped: number | null = null;
      if (s.snap) {
        const threshold = SNAP_PX / s.pxPerFrame;
        const edge = s.mode === "trim-right" ? s.originalFrom + s.originalDuration : s.originalFrom;
        const hit = snapFrame(edge + raw, s.targets, threshold);
        delta = hit.frame - edge;
        snapped = hit.snapped;
      }
      deltaRef.current = delta;
      setSnapLine(snapped);
      setDragState((prev) => (prev ? { ...prev, deltaFrames: delta } : prev));
    }
    function onUp() {
      const delta = deltaRef.current;
      setSnapLine(null);
      setDragState(null);
      if (delta === 0) return;
      if (s.mode === "move") commit(moveItem(doc, s.itemId, delta));
      else commit(trimItem(doc, s.itemId, s.mode === "trim-left" ? "left" : "right", delta, fps));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragState, doc, fps, commit]);

  // ── actions ───────────────────────────────────────────────────────────────
  const splitAtPlayhead = useCallback(() => {
    const id = [...selectedIds][0];
    if (!id) return;
    commit(splitItem(doc, id, currentFrame, fps));
  }, [selectedIds, doc, currentFrame, fps, commit]);

  const deleteSelected = useCallback((ripple: boolean) => {
    if (selectedIds.size === 0) return;
    let next = doc;
    for (const id of selectedIds) next = ripple ? rippleRemoveItem(next, id) : removeItem(next, id);
    commit(next);
    deselect();
  }, [selectedIds, doc, commit, deselect]);

  // Keyboard map mirrors components/Timeline.tsx. Cmd/Ctrl combos are left alone
  // so the page-level undo/redo still reaches its handler.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.closest(".monaco-editor"))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") { e.preventDefault(); onTogglePlay?.(); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(true); }
      else if (e.key === "s" || e.key === "S") { e.preventDefault(); splitAtPlayhead(); }
      else if (e.key === "Escape") deselect();
      else if (e.key === "ArrowLeft") { e.preventDefault(); onSeek?.(Math.max(0, currentFrame - (e.shiftKey ? 10 : 1))); }
      else if (e.key === "ArrowRight") { e.preventDefault(); onSeek?.(Math.min(total - 1, currentFrame + (e.shiftKey ? 10 : 1))); }
      else if (e.key === "Home") { e.preventDefault(); onSeek?.(0); }
      else if (e.key === "End") { e.preventDefault(); onSeek?.(total - 1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentFrame, total, onSeek, onTogglePlay, deleteSelected, splitAtPlayhead, deselect]);

  // ⌘/Ctrl-scroll to zoom, matching the other timeline.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setZoom((z) => Math.max(1, Math.min(maxZoom, z * (e.deltaY < 0 ? 1.12 : 0.89))));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [maxZoom]);

  /** Add a media file to a track at the playhead, registering its asset once. */
  const insertMedia = useCallback((file: MediaFile, trackId: string) => {
    const src = `/api/media/${projectId}/${file.path}`;
    const existing = doc.assets.find((a) => a.src === src);
    const kind: Asset["kind"] = file.type === "audio" ? "audio" : file.type === "image" ? "image" : "video";
    const durationSec = mediaDurations?.[file.path];
    const asset: Asset = existing ?? {
      id: makeId("asset"), kind, src, name: file.name, durationSec,
    };
    const frames = Math.max(1, Math.round((durationSec ?? 5) * fps));
    const item = {
      type: kind === "audio" ? "audio" : kind === "image" ? "image" : "video",
      id: makeId(kind),
      from: currentFrame,
      durationInFrames: frames,
      layout: { x: 0, y: 0, width: doc.size.width, height: doc.size.height },
      assetId: asset.id,
      ...(kind === "video" || kind === "audio" ? { sourceIn: 0, sourceOut: durationSec } : {}),
    } as EditorItem;
    const withAsset = existing ? doc : { ...doc, assets: [...doc.assets, asset] };
    commit(addItem(withAsset, trackId, item));
    setPickerOpen(false);
  }, [doc, projectId, mediaDurations, fps, currentFrame, commit]);

  /**
   * Add a text or solid layer on the first track, two seconds long, at the
   * playhead. Text defaults to Inter — the only licensed face besides GT
   * Walsheim, so the font picker must not widen beyond those plus Google Fonts.
   */
  const addLayer = useCallback((kind: "text" | "solid") => {
    const trackId = doc.tracks[doc.tracks.length - 1]?.id;
    if (!trackId) return;
    const w = Math.round(doc.size.width * 0.6);
    const h = Math.round(doc.size.height * 0.18);
    const layout = {
      x: Math.round((doc.size.width - w) / 2),
      y: Math.round((doc.size.height - h) / 2),
      width: w,
      height: h,
    };
    const common = { id: makeId(kind), from: currentFrame, durationInFrames: fps * 2, layout };
    const item = kind === "text"
      ? { ...common, type: "text" as const, text: "New text", style: { fontFamily: "Inter, sans-serif", fontSize: Math.round(doc.size.height * 0.09), fontWeight: 700, color: "#F4F4F5", align: "center" as const } }
      : { ...common, type: "solid" as const, color: "#F86606" };
    const next = addItem(doc, trackId, item as EditorItem);
    commit(next);
    onSelectionChange(new Set([common.id]));
  }, [doc, currentFrame, fps, commit, onSelectionChange]);

  /**
   * Transcribe a media file and drop its words in as a captions layer.
   *
   * Token times come back relative to the FILE, and a captions item stores times
   * relative to ITSELF, so they are rebased to the first spoken word. That is
   * what lets the finished layer be dragged anywhere on the timeline without the
   * words drifting out of sync.
   */
  const addCaptions = useCallback(async (file: MediaFile) => {
    setCaptionsBusy(file.path);
    try {
      const res = await fetch(`/api/captions/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: file.path }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Transcription failed");
      const { tokens } = (await res.json()) as { tokens: { text: string; startSec: number; endSec: number }[] };
      if (!tokens?.length) throw new Error("No speech found");

      const base = tokens[0].startSec;
      const rebased = tokens.map((t) => ({ ...t, startSec: t.startSec - base, endSec: t.endSec - base }));
      const spanSec = rebased[rebased.length - 1].endSec;
      const trackId = doc.tracks[doc.tracks.length - 1].id;
      const height = Math.round(doc.size.height * 0.22);
      const item = {
        type: "captions" as const,
        id: makeId("captions"),
        from: currentFrame,
        durationInFrames: Math.max(1, Math.round(spanSec * fps)),
        layout: {
          x: Math.round(doc.size.width * 0.08),
          y: Math.round(doc.size.height - height - doc.size.height * 0.08),
          width: Math.round(doc.size.width * 0.84),
          height,
        },
        tokens: rebased,
        style: {
          fontFamily: "Inter, sans-serif",
          fontSize: Math.round(doc.size.height * 0.058),
          fontWeight: 700,
          color: "#F4F4F5",
          align: "center" as const,
        },
        highlightColor: "#F86606",
        pageDurationMs: 1200,
        maxWordsPerPage: 6,
      };
      commit(addItem(doc, trackId, item as EditorItem));
      onSelectionChange(new Set([item.id]));
      setPickerOpen(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Transcription failed");
    } finally {
      setCaptionsBusy(null);
    }
  }, [doc, projectId, currentFrame, fps, commit, onSelectionChange]);

  // ── rendering ─────────────────────────────────────────────────────────────
  const ticks = useMemo(() => {
    const step = Math.max(1, Math.round(fps / Math.max(0.25, pxPerFrame * fps / 90)));
    const out: number[] = [];
    for (let f = 0; f <= total; f += step) out.push(f);
    return out;
  }, [fps, pxPerFrame, total]);

  const previewGeom = (item: EditorItem) => {
    if (!dragState || dragState.itemId !== item.id) return { from: item.from, dur: item.durationInFrames };
    const d = dragState.deltaFrames;
    if (dragState.mode === "move") return { from: Math.max(0, dragState.originalFrom + d), dur: dragState.originalDuration };
    if (dragState.mode === "trim-right") return { from: dragState.originalFrom, dur: Math.max(1, dragState.originalDuration + d) };
    return { from: dragState.originalFrom + d, dur: Math.max(1, dragState.originalDuration - d) };
  };

  const renderTrack = (track: Track) => (
    <div key={track.id} style={{ display: "flex", height: TRACK_H, borderBottom: "0.5px solid var(--line-1)" }}>
      <div
        style={{
          width: LABEL_W, flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
          padding: "0 6px", borderRight: "0.5px solid var(--line-1)", background: "var(--bg-2)",
        }}
      >
        <span className="mono cap" style={{ fontSize: 9, color: "var(--text-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {track.name}
        </span>
        <button
          title={track.hidden ? "Show track" : "Hide track"}
          onClick={() => commit({ ...doc, tracks: doc.tracks.map((t) => (t.id === track.id ? { ...t, hidden: !t.hidden } : t)) })}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 1, opacity: track.hidden ? 0.4 : 1 }}
        >
          <Icon name="layers" size={11} style={{ color: "var(--text-3)" }} />
        </button>
        <button
          title={track.muted ? "Unmute track" : "Mute track"}
          onClick={() => commit({ ...doc, tracks: doc.tracks.map((t) => (t.id === track.id ? { ...t, muted: !t.muted } : t)) })}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 1, opacity: track.muted ? 0.4 : 1 }}
        >
          <Icon name="monitor" size={11} style={{ color: "var(--text-3)" }} />
        </button>
        {doc.tracks.length > 1 && (
          <button
            title="Remove track"
            onClick={() => commit(removeTrack(doc, track.id))}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 1 }}
          >
            <Icon name="trash" size={11} style={{ color: "var(--text-3)" }} />
          </button>
        )}
      </div>

      <div style={{ position: "relative", width: contentW, flexShrink: 0 }} onPointerDown={deselect}>
        {track.items.map((item) => {
          const g = previewGeom(item);
          const selected = selectedIds.has(item.id);
          const asset = "assetId" in item ? getAsset(doc, (item as { assetId: string }).assetId) : undefined;
          const label = item.type === "text" ? (item as { text: string }).text : asset?.name ?? item.type;
          return (
            <div
              key={item.id}
              onPointerDown={(e) => beginDrag(e, item, "move")}
              style={{
                position: "absolute", left: g.from * pxPerFrame, width: Math.max(2, g.dur * pxPerFrame),
                top: 4, height: TRACK_H - 9, borderRadius: 3, cursor: "grab",
                background: ITEM_COLORS[item.type] ?? "var(--accent)",
                opacity: track.hidden ? 0.35 : 0.9,
                outline: selected ? "2px solid var(--text-0)" : "none",
                display: "flex", alignItems: "center", gap: 4, padding: "0 6px", overflow: "hidden",
              }}
            >
              <Icon name={ITEM_ICONS[item.type] ?? "layers"} size={10} style={{ color: "rgba(0,0,0,0.6)", flexShrink: 0 }} />
              <span className="mono" style={{ fontSize: 9, color: "rgba(0,0,0,0.75)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {label}
              </span>
              <div
                onPointerDown={(e) => beginDrag(e, item, "trim-left")}
                style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize" }}
              />
              <div
                onPointerDown={(e) => beginDrag(e, item, "trim-right")}
                style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize" }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div ref={wrapRef} style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-1)", minHeight: 0 }}>
      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderBottom: "0.5px solid var(--line-1)" }}>
        <span className="mono cap" style={{ fontSize: 9, color: "var(--text-3)" }}>Editor</span>
        <button onClick={() => setPickerOpen((v) => !v)} style={toolBtn}>+ Media</button>
        <button onClick={() => addLayer("text")} style={toolBtn}>+ Text</button>
        <button onClick={() => addLayer("solid")} style={toolBtn}>+ Solid</button>
        <button onClick={() => commit(addTrack(doc))} style={toolBtn}>+ Track</button>
        <button onClick={splitAtPlayhead} style={toolBtn} disabled={selectedIds.size !== 1}>Split</button>
        <button onClick={() => deleteSelected(true)} style={toolBtn} disabled={selectedIds.size === 0}>Delete</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSnapOn((v) => !v)} style={{ ...toolBtn, color: snapOn ? "var(--accent)" : "var(--text-3)" }}>SNAP</button>
        <button onClick={() => setZoom(1)} style={toolBtn}>Fit</button>
        <span className="mono nums" style={{ fontSize: 9, color: "var(--text-3)" }}>
          {Math.floor(currentFrame / fps / 60).toString().padStart(2, "0")}:
          {Math.floor((currentFrame / fps) % 60).toString().padStart(2, "0")}.
          {Math.floor(currentFrame % fps).toString().padStart(2, "0")}
        </span>
      </div>

      {pickerOpen && (
        <div style={{ padding: 8, borderBottom: "0.5px solid var(--line-1)", background: "var(--bg-2)", maxHeight: 140, overflowY: "auto" }}>
          {!mediaFiles || mediaFiles.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>No media in this project yet.</div>
          ) : (
            mediaFiles.map((f) => (
              <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-1)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.name}
                </span>
                {doc.tracks.map((t) => (
                  <button key={t.id} onClick={() => insertMedia(f, t.id)} style={toolBtn}>
                    → {t.name}
                  </button>
                ))}
                {(f.type === "video" || f.type === "audio") && (
                  <button
                    onClick={() => addCaptions(f)}
                    disabled={captionsBusy !== null}
                    title="Transcribe this file and add its words as a captions layer"
                    style={{ ...toolBtn, color: "var(--accent)" }}
                  >
                    {captionsBusy === f.path ? "transcribing…" : "captions"}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <div ref={scrollRef} style={{ flex: 1, overflowX: "auto", overflowY: "auto", minHeight: 0, position: "relative" }}>
        <div style={{ display: "flex", width: LABEL_W + contentW }}>
          <div style={{ width: LABEL_W, flexShrink: 0, height: RULER_H, borderRight: "0.5px solid var(--line-1)", borderBottom: "0.5px solid var(--line-1)", background: "var(--bg-2)" }} />
          <div
            ref={rulerRef}
            onPointerDown={startScrub}
            style={{ position: "relative", width: contentW, height: RULER_H, borderBottom: "0.5px solid var(--line-1)", cursor: "ew-resize", background: "var(--bg-2)" }}
          >
            {ticks.map((f) => (
              <div key={f} style={{ position: "absolute", left: f * pxPerFrame, top: 0, bottom: 0, borderLeft: "0.5px solid var(--line-1)", paddingLeft: 3 }}>
                <span className="mono nums" style={{ fontSize: 8, color: "var(--text-3)" }}>{(f / fps).toFixed(1)}s</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ width: LABEL_W + contentW }}>{doc.tracks.map(renderTrack)}</div>

        {/* playhead + snap guide, spanning ruler and tracks */}
        <div style={{ position: "absolute", left: LABEL_W + currentFrame * pxPerFrame, top: 0, bottom: 0, width: 1, background: "var(--accent)", pointerEvents: "none", zIndex: 5 }} />
        {snapLine != null && (
          <div style={{ position: "absolute", left: LABEL_W + snapLine * pxPerFrame, top: 0, bottom: 0, width: 1, background: "var(--text-0)", opacity: 0.5, pointerEvents: "none", zIndex: 4 }} />
        )}
      </div>
    </div>
  );
}

const toolBtn: React.CSSProperties = {
  background: "var(--bg-3)",
  border: "0.5px solid var(--line-2)",
  borderRadius: 3,
  color: "var(--text-1)",
  fontSize: 10,
  padding: "2px 7px",
  cursor: "pointer",
};
