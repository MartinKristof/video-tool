"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseTimeline, getClipColor, type TimelineClip } from "@/lib/timeline-parser";
import {
  analyzeEditability,
  codeFromDoc,
  trimClipLeft,
  trimClipRight,
  splitClip,
  rippleDeleteClip,
  rippleDeleteClips,
  reorderClip,
  moveClip,
  type EditableDoc,
} from "@/lib/editable-timeline";
import {
  parseDataTimeline,
  dataRippleDelete,
  dataRippleDeleteMany,
  dataReorder,
  dataTrim,
  dataSplit,
  parseSegments,
  segmentDelete,
  segmentDeleteMany,
  segmentReorder,
  segmentTrim,
  type DataTimeline,
  type SegmentArray,
} from "@/lib/data-timeline";
import { evalSceneCode } from "@/remotion/DynamicScene";
import type { ResolvedClip } from "@/lib/timeline-extract";
import Icon from "@/components/ui/Icon";
import IconButton from "@/components/ui/IconButton";
import Modal from "@/components/ui/Modal";
import Kbd from "@/components/ui/Kbd";

interface TimelineProps {
  code: string;
  fps: number;
  durationInFrames: number;
  onCodeChange?: (next: string) => void;
  nativeFpsBySrc?: Record<string, number>;
  maxSrcFrameBySrc?: Record<string, number>;
  /** Runtime-extracted clip layout (display-only) for comps the static parsers can't read. */
  resolvedClips?: ResolvedClip[] | null;
  /** True when the hidden runtime extractor is active for this composition. */
  extracting?: boolean;
  currentFrame?: number;
  onSeek?: (frame: number) => void;
  onScrubStart?: () => void;
  onTogglePlay?: () => void;
  isPlaying?: boolean;
}

type DragMode = "move" | "trim-left" | "trim-right";
type EditMode = "doc" | "data" | "segment" | "none";

interface DragState {
  clipId: string;
  mode: DragMode;
  originalFrom: number;
  originalDuration: number;
  startX: number;
  pxPerFrame: number;
  deltaFrames: number;
  snapTargets: number[];
  snap: boolean;
  // Max composition duration this clip can grow to before reading past its source
  // footage (doc-mode video clips with a known source length); undefined = no cap.
  maxDurationCap?: number;
}

// A clip as shown on the timeline, independent of which edit model produced it.
interface LaneClip {
  key: string;
  clipId?: string; // editable id (doc/data); undefined = display-only
  colorIndex: number;
  from: number;
  durationInFrames: number;
  name: string;
  startFrom?: number;
  endAt?: number;
}
interface Lane {
  label: string;
  icon: string;
  editable: boolean;
  clips: LaneClip[];
}

const LABEL_W = 72;
const RULER_H = 22;
const TRACK_H = 38;
const SNAP_PX = 8;
const MAX_PX_PER_FRAME = 16;

// A scissors cursor (white glyph + dark halo for contrast) shown while Option/Alt
// is held over an editable clip, signalling the alt-click "cut" tool is armed.
const SCISSORS_CURSOR = (() => {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 16 16' fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
    "<g stroke='black' stroke-width='3'><circle cx='4' cy='4' r='2'/><circle cx='4' cy='12' r='2'/><path d='M5.8 5.4 14 12M5.8 10.6 14 4'/></g>" +
    "<g stroke='white' stroke-width='1.4'><circle cx='4' cy='4' r='2'/><circle cx='4' cy='12' r='2'/><path d='M5.8 5.4 14 12M5.8 10.6 14 4'/></g></svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 11, crosshair`;
})();

function formatTime(frames: number, fps: number): string {
  const totalSeconds = frames / fps;
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0) return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
  return `${secs.toFixed(1)}s`;
}
function formatFrames(frames: number): string {
  return `${frames}f`;
}

const NICE_INTERVALS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function pickMarkerInterval(totalSeconds: number, pxPerSecond: number): number {
  const target = 70 / Math.max(pxPerSecond, 0.0001);
  let nice = NICE_INTERVALS.find((n) => n >= target) ?? NICE_INTERVALS[NICE_INTERVALS.length - 1];
  while (totalSeconds / nice > 200) {
    const idx = NICE_INTERVALS.indexOf(nice);
    if (idx < 0 || idx === NICE_INTERVALS.length - 1) {
      nice = totalSeconds / 200;
      break;
    }
    nice = NICE_INTERVALS[idx + 1];
  }
  return nice;
}

// Simple {id, from, durationInFrames} view used for snapping + reorder math.
interface EditUnit {
  id: string;
  from: number;
  durationInFrames: number;
}

export default function Timeline({
  code,
  fps,
  durationInFrames,
  onCodeChange,
  nativeFpsBySrc,
  maxSrcFrameBySrc,
  resolvedClips,
  extracting,
  currentFrame = 0,
  onSeek,
  onScrubStart,
  onTogglePlay,
  isPlaying,
}: TimelineProps) {
  const parsed = useMemo(() => parseTimeline(code, fps), [code, fps]);

  // Editability: try the byte-patch doc model (video / plain-scene) first, then
  // the data-driven segment-array model, else read-only (with a reason).
  const { editableDoc, docReason } = useMemo(() => {
    if (!onCodeChange) return { editableDoc: null as EditableDoc | null, docReason: null as string | null };
    const r = analyzeEditability(code, fps, nativeFpsBySrc, maxSrcFrameBySrc);
    return { editableDoc: r.doc, docReason: r.reason };
  }, [code, fps, onCodeChange, nativeFpsBySrc, maxSrcFrameBySrc]);

  const dataTimeline = useMemo<DataTimeline | null>(() => {
    if (!onCodeChange || editableDoc) return null;
    return parseDataTimeline(code, fps, durationInFrames);
  }, [code, fps, onCodeChange, editableDoc, durationInFrames]);

  // Computed layouts (card+answer per topic, crossfades) don't validate as data
  // mode, but their driving SEGMENTS array is editable at the topic level. We
  // correlate each runtime-extracted footage clip to a segment by its source in/out.
  const segmentArray = useMemo<SegmentArray | null>(() => {
    if (!onCodeChange || editableDoc || dataTimeline) return null;
    return parseSegments(code, fps);
  }, [code, fps, onCodeChange, editableDoc, dataTimeline]);

  // Compute each topic's timeline span with pure math (no hidden render): each
  // topic = a title card + its answer footage. Answer length comes from
  // startSec/endSec; the (equal) card length is derived from the leftover between
  // the total video length and the sum of answers. If that leftover isn't a
  // plausible per-card duration, the edit isn't topic-structured → skip.
  const topicClips = useMemo(() => {
    if (!segmentArray || !durationInFrames) return null;
    const segs = segmentArray.segments;
    const answerDurs = segs.map((s) => Math.max(1, Math.round((s.endSec - s.startSec) * fps)));
    const sumAns = answerDurs.reduce((a, b) => a + b, 0);
    const cardNet = (durationInFrames - sumAns) / segs.length;
    if (!(cardNet >= 0) || cardNet > fps * 20) return null; // implausible → not topic-structured
    const card = Math.round(cardNet);
    let cursor = 0;
    return segs.map((s, i) => {
      const dur = card + answerDurs[i];
      const from = cursor;
      cursor += dur;
      return { segId: s.id, from, durationInFrames: dur, label: s.label };
    });
  }, [segmentArray, durationInFrames, fps]);

  const editMode: EditMode = editableDoc ? "doc" : dataTimeline ? "data" : segmentArray && topicClips ? "segment" : "none";
  const isEditable = editMode !== "none";
  // Splitting applies to clip-level modes; topic-level segment mode has no split.
  const canSplit = editMode === "doc" || editMode === "data";

  const readOnlyReason = useMemo(() => {
    if (!onCodeChange || isEditable) return null;
    if (docReason) return docReason;
    // Data-driven layout we couldn't safely map (overlaps / computed positions).
    if (/\.map\s*\(/.test(code) && /<Sequence\b/.test(code)) {
      return "Computed layout — scrub here; cut via chat or the code panel";
    }
    return null;
  }, [onCodeChange, isEditable, docReason, code]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerLaneRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);
  const [altHeld, setAltHeld] = useState(false);
  const [cutFrame, setCutFrame] = useState<number | null>(null);

  // Track Option/Alt so we can show the "cut" (scissors) cursor + preview line.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      setAltHeld(e.altKey);
      if (!e.altKey) setCutFrame(null);
    };
    const reset = () => {
      setAltHeld(false);
      setCutFrame(null);
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, []);

  const selectOnly = useCallback((id: string) => setSelectedIds(new Set([id])), []);
  const deselectAll = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelected = useCallback(
    (id: string) => setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }),
    [],
  );
  // Latest drag delta, read on pointer-up so the commit runs in the event
  // handler (never inside a setState updater — that's an update-during-render).
  const deltaRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build display lanes from the active model.
  const lanes: Lane[] = useMemo(() => {
    if (editMode === "data" && dataTimeline) {
      return [
        {
          label: "Clips",
          icon: "film",
          editable: true,
          clips: dataTimeline.clips.map((c, i) => ({
            key: c.id,
            clipId: c.id,
            colorIndex: i,
            from: c.from,
            durationInFrames: c.durationInFrames,
            name: c.label || (c.kind ? c.kind : `Clip ${i + 1}`),
          })),
        },
      ];
    }
    // Segment mode: one editable "Topics" lane, one box per topic (card + answer),
    // positioned by the computed layout. Editing a box edits that whole topic.
    if (editMode === "segment" && topicClips) {
      return [
        {
          label: "Topics",
          icon: "film",
          editable: true,
          clips: topicClips.map((t, i) => ({
            key: t.segId,
            clipId: t.segId,
            colorIndex: i,
            from: t.from,
            durationInFrames: t.durationInFrames,
            name: t.label,
          })),
        },
      ];
    }
    // Not statically editable, but the runtime extractor resolved real clips →
    // show them (display-only; clicking one scrubs there).
    if (editMode === "none" && resolvedClips && resolvedClips.length > 0) {
      const g: { label: string; icon: string; editable: boolean; clips: LaneClip[] }[] = [
        { label: "Video", icon: "film", editable: false, clips: [] },
        { label: "Scenes", icon: "layers", editable: false, clips: [] },
        { label: "Audio", icon: "monitor", editable: false, clips: [] },
      ];
      resolvedClips.forEach((c, i) => {
        const laneIdx = c.kind === "audio" ? 2 : c.kind === "scene" ? 1 : 0;
        g[laneIdx].clips.push({
          key: c.id,
          clipId: undefined,
          colorIndex: i,
          from: c.from,
          durationInFrames: c.durationInFrames,
          name: c.label,
          startFrom: c.startFrom,
          endAt: c.endAt,
        });
      });
      return g.filter((x) => x.clips.length > 0);
    }
    const groups: { label: string; icon: string; editable: boolean; clips: LaneClip[] }[] = [
      { label: "Video", icon: "film", editable: false, clips: [] },
      { label: "Scenes", icon: "layers", editable: false, clips: [] },
      { label: "Audio", icon: "monitor", editable: false, clips: [] },
      { label: "Overlay", icon: "layers", editable: false, clips: [] },
    ];

    // Doc mode: lanes come straight from the editable doc, so every clip drawn
    // carries its own edit id. (This used to walk parseTimeline's clips and pair
    // them with doc clips by counting positions per kind — two different parsers
    // that could disagree, and which left audio and overlays with no id at all.)
    if (editMode === "doc" && editableDoc) {
      editableDoc.clips.forEach((c, i) => {
        const laneIdx =
          c.kind === "audio" ? 2 : c.kind === "video" ? 0 : c.track === "free" ? 3 : 1;
        groups[laneIdx].clips.push({
          key: `${c.id}_${i}`,
          clipId: c.id,
          colorIndex: i,
          from: c.from,
          durationInFrames: c.durationInFrames,
          name: c.label,
          startFrom: c.startFrom,
          endAt: c.endAt,
        });
      });
      // Every lane is editable now — audio and overlays included. Nothing gets
      // regenerated on an edit, so there is nothing left to protect them from.
      for (const g of groups) g.editable = true;
      return groups.filter((g) => g.clips.length > 0);
    }

    // Read-only: parseTimeline is all we have — draw it, don't offer edit ids.
    parsed.forEach((clip: TimelineClip, i) => {
      const laneIdx =
        clip.type === "video" ? 0 : clip.type === "scene" ? 1 : clip.type === "audio" ? 2 : 3;
      groups[laneIdx].clips.push({
        key: `c_${i}`,
        clipId: undefined,
        colorIndex: i,
        from: clip.from,
        durationInFrames: clip.durationInFrames,
        name: clip.name,
        startFrom: clip.startFrom,
        endAt: clip.endAt,
      });
    });
    return groups.filter((g) => g.clips.length > 0);
  }, [editMode, dataTimeline, parsed, editableDoc, resolvedClips, topicClips]);

  // Flat {id,from,dur} list of editable units for snapping + reorder math.
  const editUnits: EditUnit[] = useMemo(() => {
    if (editMode === "doc" && editableDoc) return editableDoc.clips.map((c) => ({ id: c.id, from: c.from, durationInFrames: c.durationInFrames }));
    if (editMode === "data" && dataTimeline) return dataTimeline.clips.map((c) => ({ id: c.id, from: c.from, durationInFrames: c.durationInFrames }));
    if (editMode === "segment" && topicClips) {
      return topicClips.map((t) => ({ id: t.segId, from: t.from, durationInFrames: t.durationInFrames }));
    }
    return [];
  }, [editMode, editableDoc, dataTimeline, topicClips]);

  const baseTotalFrames = Math.max(1, durationInFrames, ...parsed.map((c) => c.from + c.durationInFrames), ...editUnits.map((u) => u.from + u.durationInFrames));
  const availableTrackW = Math.max(120, containerWidth - LABEL_W - 8);
  const fitPx = availableTrackW / baseTotalFrames;
  const maxZoom = Math.max(2, Math.min(300, MAX_PX_PER_FRAME / Math.max(fitPx, 0.0001)));
  const clampZoom = useCallback((z: number) => Math.max(1, Math.min(maxZoom, z)), [maxZoom]);
  const pxPerFrame = fitPx * Math.min(zoom, maxZoom);

  let totalFrames = baseTotalFrames;
  if (dragState) {
    const u = editUnits.find((c) => c.id === dragState.clipId);
    if (u) {
      let pendingEnd = u.from + u.durationInFrames;
      if (dragState.mode === "trim-right") pendingEnd = u.from + Math.max(1, u.durationInFrames + dragState.deltaFrames);
      else if (dragState.mode === "move") pendingEnd = Math.max(0, u.from + dragState.deltaFrames) + u.durationInFrames;
      totalFrames = Math.max(totalFrames, pendingEnd);
    }
  }
  const contentWidth = totalFrames * pxPerFrame;
  const totalSeconds = totalFrames / fps;
  const markerInterval = pickMarkerInterval(totalSeconds, pxPerFrame * fps);
  const markers: number[] = [];
  for (let t = 0; t <= totalSeconds + 0.001; t += markerInterval) markers.push(t);

  const edgeTargets = useMemo(() => {
    const s = new Set<number>([0, baseTotalFrames]);
    for (const c of parsed) {
      s.add(c.from);
      s.add(c.from + c.durationInFrames);
    }
    for (const u of editUnits) {
      s.add(u.from);
      s.add(u.from + u.durationInFrames);
    }
    return [...s].sort((a, b) => a - b);
  }, [parsed, editUnits, baseTotalFrames]);

  // Latest values for the mount-once keyboard handler. Written after render, not
  // during it: the handlers only read `latest.current` from events, which always
  // run after the effect has refreshed it.
  const latest = useRef({ editMode, editableDoc, dataTimeline, segmentArray, currentFrame, selectedIds, onCodeChange, onTogglePlay, onSeek, total: baseTotalFrames });
  useEffect(() => {
    latest.current = { editMode, editableDoc, dataTimeline, segmentArray, currentFrame, selectedIds, onCodeChange, onTogglePlay, onSeek, total: baseTotalFrames };
  });

  const commitCode = useCallback(
    (next: string, alsoDeselect = false) => {
      if (!onCodeChange || next === code) return;
      // Never push a broken edit into the preview: if the new code won't compile,
      // skip the commit and flash a message instead of blanking the player.
      const ev = evalSceneCode(next);
      if (ev?.error) {
        setCommitError("Edit skipped — it would break the preview");
        window.setTimeout(() => setCommitError(null), 3500);
        return;
      }
      onCodeChange(next);
      if (alsoDeselect) deselectAll();
    },
    [onCodeChange, code, deselectAll],
  );
  // Stable handle so the (deps-free) keyboard callbacks can use the validated committer.
  const commitRef = useRef(commitCode);
  useEffect(() => {
    commitRef.current = commitCode;
  }, [commitCode]);

  const bladeAtPlayhead = useCallback(() => {
    const L = latest.current;
    if (!L.onCodeChange) return;
    const f = L.currentFrame;
    const spans = (c: { from: number; durationInFrames: number }) => f > c.from && f < c.from + c.durationInFrames;
    if (L.editMode === "doc" && L.editableDoc) {
      const target = L.editableDoc.clips.find((c) => L.selectedIds.has(c.id) && spans(c)) ?? L.editableDoc.clips.find(spans);
      if (!target) return;
      const next = splitClip(L.editableDoc, target.id, f);
      if (next !== L.editableDoc) commitRef.current(codeFromDoc(next));
    } else if (L.editMode === "data" && L.dataTimeline) {
      const target = L.dataTimeline.clips.find((c) => L.selectedIds.has(c.id) && spans(c)) ?? L.dataTimeline.clips.find(spans);
      if (!target) return;
      const next = dataSplit(L.dataTimeline, target.id, f);
      if (next !== L.dataTimeline.code) commitRef.current(next);
    }
  }, []);

  const rippleSelected = useCallback(() => {
    const L = latest.current;
    const ids = [...L.selectedIds];
    if (!L.onCodeChange || ids.length === 0) return;
    if (L.editMode === "doc" && L.editableDoc) {
      const next = ids.length === 1 ? rippleDeleteClip(L.editableDoc, ids[0]) : rippleDeleteClips(L.editableDoc, ids);
      if (next !== L.editableDoc) commitRef.current(codeFromDoc(next), true);
    } else if (L.editMode === "data" && L.dataTimeline) {
      const next = ids.length === 1 ? dataRippleDelete(L.dataTimeline, ids[0]) : dataRippleDeleteMany(L.dataTimeline, ids);
      if (next !== L.dataTimeline.code) commitRef.current(next, true);
    } else if (L.editMode === "segment" && L.segmentArray) {
      const next = ids.length === 1 ? segmentDelete(L.segmentArray, ids[0]) : segmentDeleteMany(L.segmentArray, ids);
      if (next !== L.segmentArray.code) commitRef.current(next, true);
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.closest(".monaco-editor") || a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const L = latest.current;
      if (e.key === " ") {
        if (a && a.closest(".__remotion-player")) return;
        if (!L.onTogglePlay) return;
        e.preventDefault();
        L.onTogglePlay();
        return;
      }
      // Playhead navigation (works regardless of editability).
      if (L.onSeek && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const maxF = Math.max(0, L.total - 1);
        if (e.key === "ArrowLeft") L.onSeek(Math.max(0, L.currentFrame - step));
        else if (e.key === "ArrowRight") L.onSeek(Math.min(maxF, L.currentFrame + step));
        else if (e.key === "Home") L.onSeek(0);
        else L.onSeek(maxF);
        return;
      }
      if (e.key === "Escape") {
        setContextMenu(null);
        deselectAll();
        return;
      }
      if (L.editMode === "none" || !L.onCodeChange) return;
      if (e.key === "s" || e.key === "S" || e.key === "b" || e.key === "B") {
        e.preventDefault();
        bladeAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        rippleSelected();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bladeAtPlayhead, rippleSelected, deselectAll]);

  // Clip drag (move / trim) with snapping. The drag's fixed fields come from the
  // dragState captured when the drag started; the live delta lives in deltaRef so
  // the pointer-up commit runs in the event handler, not a setState updater.
  useEffect(() => {
    if (!dragState) return;
    const s = dragState;
    function handleMove(e: PointerEvent) {
      const rawDelta = Math.round((e.clientX - s.startX) / s.pxPerFrame);
      if (!s.snap) {
        deltaRef.current = rawDelta;
        setSnapLine(null);
        setDragState((prev) => (prev ? { ...prev, deltaFrames: rawDelta } : prev));
        return;
      }
      const thr = SNAP_PX / s.pxPerFrame;
      let deltaFrames = rawDelta;
      let snapped: number | null = null;
      if (s.mode === "trim-right") {
        const rightEdge = s.originalFrom + s.originalDuration;
        const best = nearestSnap(rightEdge + rawDelta, s.snapTargets, thr);
        deltaFrames = (best ?? rightEdge + rawDelta) - rightEdge;
        snapped = best;
      } else {
        const best = nearestSnap(s.originalFrom + rawDelta, s.snapTargets, thr);
        deltaFrames = (best ?? s.originalFrom + rawDelta) - s.originalFrom;
        snapped = best;
      }
      deltaRef.current = deltaFrames;
      setSnapLine(snapped);
      setDragState((prev) => (prev ? { ...prev, deltaFrames } : prev));
    }
    function handleUp() {
      const delta = deltaRef.current;
      setSnapLine(null);
      setDragState(null);
      if (!onCodeChange) return;
      if (delta === 0 && s.mode !== "move") return;
      if (editMode === "doc" && editableDoc) {
        // Trims ripple the base track themselves, so there is no re-pack step.
        if (s.mode === "trim-right") commitCode(codeFromDoc(trimClipRight(editableDoc, s.clipId, delta)));
        else if (s.mode === "trim-left") commitCode(codeFromDoc(trimClipLeft(editableDoc, s.clipId, delta)));
        else {
          const dragged = editableDoc.clips.find((c) => c.id === s.clipId);
          if (dragged?.track === "free") {
            // A music bed or a caption goes exactly where it is dropped.
            commitCode(codeFromDoc(moveClip(editableDoc, s.clipId, delta)), true);
          } else {
            // Reorder against the base track only — free clips aren't slots.
            const baseIds = new Set(
              editableDoc.clips.filter((c) => c.track === "base").map((c) => c.id),
            );
            const baseUnits = editUnits.filter((u) => baseIds.has(u.id));
            commitCode(
              codeFromDoc(
                reorderClip(editableDoc, s.clipId, reorderIndex(baseUnits, s.clipId, s.originalFrom + delta)),
              ),
              true,
            );
          }
        }
      } else if (editMode === "data" && dataTimeline) {
        if (s.mode === "trim-right") commitCode(dataTrim(dataTimeline, s.clipId, "right", delta));
        else if (s.mode === "trim-left") commitCode(dataTrim(dataTimeline, s.clipId, "left", delta));
        else commitCode(dataReorder(dataTimeline, s.clipId, reorderIndex(editUnits, s.clipId, s.originalFrom + delta)), true);
      } else if (editMode === "segment" && segmentArray) {
        if (s.mode === "trim-right") commitCode(segmentTrim(segmentArray, s.clipId, "right", delta));
        else if (s.mode === "trim-left") commitCode(segmentTrim(segmentArray, s.clipId, "left", delta));
        else commitCode(segmentReorder(segmentArray, s.clipId, reorderIndex(editUnits, s.clipId, s.originalFrom + delta)), true);
      }
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragState, editMode, editableDoc, dataTimeline, segmentArray, editUnits, onCodeChange, commitCode]);

  const frameFromClientX = useCallback(
    (clientX: number): number => {
      const lane = rulerLaneRef.current;
      if (!lane) return 0;
      const rect = lane.getBoundingClientRect();
      let f = (clientX - rect.left) / pxPerFrame;
      f = Math.max(0, Math.min(totalFrames, f));
      if (!snapEnabled) return Math.round(f);
      const best = nearestSnap(f, edgeTargets, SNAP_PX / pxPerFrame);
      return Math.round(best ?? f);
    },
    [pxPerFrame, totalFrames, edgeTargets, snapEnabled],
  );

  useEffect(() => {
    if (!scrubbing) return;
    function handleMove(e: PointerEvent) {
      onSeek?.(frameFromClientX(e.clientX));
    }
    function handleUp() {
      setScrubbing(false);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [scrubbing, onSeek, frameFromClientX]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom <= 1) return;
    const px = LABEL_W + currentFrame * pxPerFrame;
    const left = el.scrollLeft;
    const right = left + el.clientWidth;
    if (px < left + LABEL_W || px > right - 24) el.scrollLeft = Math.max(0, px - el.clientWidth * 0.3);
  }, [currentFrame, pxPerFrame, zoom]);

  const onLanePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!onSeek) return;
      setContextMenu(null);
      deselectAll();
      onScrubStart?.();
      onSeek(frameFromClientX(e.clientX));
      setScrubbing(true);
    },
    [onSeek, onScrubStart, frameFromClientX, deselectAll],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    },
    [clampZoom],
  );

  // While Option is held, track the cursor frame (no snapping — matches where an
  // alt-click actually cuts) so we can draw a preview cut line.
  const onContentMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!altHeld || !canSplit) return;
      const lane = rulerLaneRef.current;
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      const f = Math.round((e.clientX - rect.left) / pxPerFrame);
      setCutFrame(Math.max(0, Math.min(totalFrames, f)));
    },
    [altHeld, canSplit, pxPerFrame, totalFrames],
  );

  function startDrag(e: React.PointerEvent<HTMLDivElement>, clipId: string, originalFrom: number, originalDuration: number, mode: DragMode) {
    e.preventDefault();
    e.stopPropagation();
    // Dragging selects the clip, unless it's already part of a multi-selection.
    setSelectedIds((prev) => (prev.has(clipId) ? prev : new Set([clipId])));
    deltaRef.current = 0;
    // Compute how far a trim-right can grow before running out of footage, so the
    // drag ghost caps at the same point the commit will (no visual overshoot).
    let maxDurationCap: number | undefined;
    if (editMode === "doc" && editableDoc) {
      const c = editableDoc.clips.find((x) => x.id === clipId);
      if (c && c.maxSourceFrame != null) {
        const native = c.nativeFps && c.nativeFps > 0 ? c.nativeFps : fps;
        const currentSourceEnd = c.endAt != null ? c.endAt : (c.startFrom ?? 0) + Math.round((c.durationInFrames * native) / fps);
        const maxGrowthSource = Math.max(0, c.maxSourceFrame - currentSourceEnd);
        maxDurationCap = c.durationInFrames + Math.round((maxGrowthSource * fps) / native);
      }
    }
    setDragState({
      clipId,
      mode,
      originalFrom,
      originalDuration,
      startX: e.clientX,
      pxPerFrame,
      deltaFrames: 0,
      snapTargets: snapTargetsFor(editUnits, clipId, currentFrame),
      snap: snapEnabled,
      maxDurationCap,
    });
  }

  const clipUnderPlayhead = editUnits.some((c) => currentFrame > c.from && currentFrame < c.from + c.durationInFrames);

  if (parsed.length === 0 && editUnits.length === 0 && !onSeek && !onCodeChange) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-3)", fontSize: 11, gap: 6 }}>
        <Icon name="film" size={13} />
        No timeline data — generate or edit code to see clips
      </div>
    );
  }

  const innerWidth = LABEL_W + contentWidth;

  // Where a dragged clip would drop (start of its target slot in the re-packed row).
  let insertionFrame: number | null = null;
  if (dragState && dragState.mode === "move" && editUnits.length > 1) {
    const newFrom = Math.max(0, dragState.originalFrom + dragState.deltaFrames);
    const idx = reorderIndex(editUnits, dragState.clipId, newFrom);
    const others = editUnits.filter((u) => u.id !== dragState.clipId).sort((a, b) => a.from - b.from);
    let acc = 0;
    for (let i = 0; i < idx && i < others.length; i++) acc += others[i].durationInFrames;
    insertionFrame = acc;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header / toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "0.5px solid var(--line-1)", flexShrink: 0 }}>
        <Icon name="film" size={13} style={{ color: "var(--text-2)" }} />
        <span className="mono cap" style={{ color: "var(--text-1)" }}>Timeline</span>
        {onCodeChange &&
          (isEditable ? (
            <span
              className="mono"
              style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "var(--accent-soft)", color: "var(--accent)", border: "0.5px solid var(--accent-line)", letterSpacing: "0.05em", textTransform: "uppercase" }}
              title={editMode === "segment" ? "Drag a topic to reorder · drag its edges to trim the footage · Del = remove topic" : "Drag a clip to reorder · drag edges to trim · S = split at playhead · Del = delete + close gap"}
            >
              Editable
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "var(--bg-4)", color: "var(--text-2)", border: "0.5px solid var(--line-2)", letterSpacing: "0.05em", textTransform: "uppercase" }} title={readOnlyReason ?? "This composition can't be hand-edited on the timeline"}>
              Read-only
            </span>
          ))}
        {!isEditable && readOnlyReason && <span className="mono" style={{ fontSize: 9, color: "var(--text-3)" }}>{readOnlyReason}</span>}
        {extracting && !isEditable && (
          <span className="mono" style={{ fontSize: 9, color: "var(--text-3)" }}>
            {resolvedClips == null ? "· scanning clips…" : resolvedClips.length > 0 ? `· ${resolvedClips.length} clips detected` : "· no clips detected"}
          </span>
        )}
        {commitError && <span className="mono" style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "var(--red-soft)", color: "var(--red)", border: "0.5px solid var(--red)" }}>{commitError}</span>}

        <div style={{ flex: 1 }} />

        {onTogglePlay && <IconButton icon={isPlaying ? "pause" : "play"} size={26} title={isPlaying ? "Pause (Space)" : "Play (Space)"} onClick={onTogglePlay} />}
        <span className="mono nums" style={{ fontSize: 10, color: "var(--text-2)", minWidth: 96, textAlign: "right" }}>
          {formatTime(currentFrame, fps)} / {formatTime(baseTotalFrames, fps)}
        </span>

        {isEditable && (
          <div style={{ display: "flex", gap: 1 }}>
            {canSplit && <IconButton icon="scissors" size={26} title="Split at playhead (S)" onClick={bladeAtPlayhead} style={{ opacity: clipUnderPlayhead ? 1 : 0.35 }} />}
            <IconButton icon="trash" size={26} title="Delete selected + close gap (Del)" onClick={rippleSelected} style={{ opacity: selectedIds.size > 0 ? 1 : 0.35 }} />
          </div>
        )}

        <button
          onClick={() => setSnapEnabled((v) => !v)}
          className="mono"
          title="Snap to clip edges & playhead"
          style={{ fontSize: 9, padding: "3px 6px", background: snapEnabled ? "var(--accent-soft)" : "var(--bg-inset)", color: snapEnabled ? "var(--accent)" : "var(--text-2)", border: "0.5px solid var(--line-2)", borderRadius: 3, cursor: "pointer" }}
        >
          SNAP
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton icon="zoomOut" size={26} title="Zoom out" onClick={() => setZoom((z) => clampZoom(z / 1.5))} />
          <button
            onClick={() => setZoom(1)}
            className="mono"
            title="Fit to width"
            style={{ fontSize: 9, padding: "3px 6px", background: zoom === 1 ? "var(--accent-soft)" : "var(--bg-inset)", color: zoom === 1 ? "var(--accent)" : "var(--text-2)", border: "0.5px solid var(--line-2)", borderRadius: 3, cursor: "pointer" }}
          >
            FIT
          </button>
          <IconButton icon="zoomIn" size={26} title="Zoom in" onClick={() => setZoom((z) => clampZoom(z * 1.5))} />
        </div>
        <IconButton icon="info" size={26} title="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)} />
      </div>

      {/* Scroll area */}
      <div ref={scrollRef} className="vt-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto" }} onWheel={onWheel}>
        <div
          style={{ position: "relative", width: innerWidth, minWidth: "100%", paddingBottom: 6 }}
          onMouseMove={onContentMouseMove}
          onMouseLeave={() => setCutFrame(null)}
        >
          {/* Ruler */}
          <div style={{ display: "flex", height: RULER_H }}>
            <div style={{ position: "sticky", left: 0, zIndex: 6, width: LABEL_W, flexShrink: 0, background: "var(--bg-2)", borderRight: "0.5px solid var(--line-1)", borderBottom: "0.5px solid var(--line-2)" }} />
            <div ref={rulerLaneRef} onPointerDown={onLanePointerDown} style={{ position: "relative", width: contentWidth, borderBottom: "0.5px solid var(--line-2)", cursor: onSeek ? "text" : "default" }}>
              {markers.map((t) => (
                <div key={t} style={{ position: "absolute", left: t * fps * pxPerFrame, top: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start", pointerEvents: "none" }}>
                  <span className="mono nums" style={{ fontSize: 9, color: "var(--text-3)", whiteSpace: "nowrap", paddingLeft: 3 }}>
                    {t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${markerInterval < 1 ? t.toFixed(1) : Math.round(t)}s`}
                  </span>
                  <div style={{ width: 1, flex: 1, background: "var(--line-1)" }} />
                </div>
              ))}
            </div>
          </div>

          {/* Tracks */}
          {lanes.map((lane, li) => (
            <div key={li} style={{ display: "flex", height: TRACK_H }}>
              <div style={{ position: "sticky", left: 0, zIndex: 6, width: LABEL_W, flexShrink: 0, display: "flex", alignItems: "center", gap: 5, padding: "0 10px", background: "var(--bg-2)", borderRight: "0.5px solid var(--line-1)" }}>
                <Icon name={lane.icon} size={11} style={{ color: "var(--text-3)" }} />
                <span className="mono cap" style={{ color: "var(--text-3)", fontSize: 9 }}>{lane.label}</span>
              </div>
              <div onPointerDown={onLanePointerDown} style={{ position: "relative", width: contentWidth, height: "100%", background: "var(--bg-inset)", borderBottom: "0.5px solid var(--line-1)" }}>
                {lane.clips.map((clip) => {
                  const draggable = lane.editable && clip.clipId != null;
                  const isDragging = dragState != null && clip.clipId === dragState.clipId;
                  let renderFrom = clip.from;
                  let renderDuration = clip.durationInFrames;
                  if (isDragging && dragState) {
                    if (dragState.mode === "move") renderFrom = Math.max(0, dragState.originalFrom + dragState.deltaFrames);
                    else if (dragState.mode === "trim-right") renderDuration = Math.min(dragState.maxDurationCap ?? Infinity, Math.max(1, dragState.originalDuration + dragState.deltaFrames));
                    else {
                      const clamped = Math.max(-dragState.originalFrom, Math.min(dragState.originalDuration - 1, dragState.deltaFrames));
                      renderFrom = dragState.originalFrom + clamped;
                      renderDuration = dragState.originalDuration - clamped;
                    }
                  }
                  const left = renderFrom * pxPerFrame;
                  const width = Math.max(2, renderDuration * pxPerFrame);
                  const color = getClipColor(clip.colorIndex);
                  const isHovered = hoveredKey === clip.key;
                  const isSelected = clip.clipId != null && selectedIds.has(clip.clipId);
                  return (
                    <div
                      key={clip.key}
                      onMouseEnter={() => !isDragging && setHoveredKey(clip.key)}
                      onMouseLeave={() => setHoveredKey(null)}
                      onPointerDown={(e) => {
                        if (!draggable || !clip.clipId) return; // display-only → falls through to seek
                        // Shift / Cmd / Ctrl click toggles multi-selection (no drag).
                        if (e.shiftKey || e.metaKey || e.ctrlKey) {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleSelected(clip.clipId);
                          return;
                        }
                        // Alt-click splits at the cursor.
                        if (e.altKey && onCodeChange && canSplit) {
                          const rect = rulerLaneRef.current?.getBoundingClientRect();
                          if (rect) {
                            const frame = Math.round((e.clientX - rect.left) / pxPerFrame);
                            if (editMode === "doc" && editableDoc) {
                              const next = splitClip(editableDoc, clip.clipId, frame);
                              if (next !== editableDoc) commitCode(codeFromDoc(next));
                            } else if (editMode === "data" && dataTimeline) {
                              const next = dataSplit(dataTimeline, clip.clipId, frame);
                              if (next !== dataTimeline.code) commitCode(next);
                            }
                          }
                          e.preventDefault();
                          e.stopPropagation();
                          return;
                        }
                        startDrag(e, clip.clipId, clip.from, clip.durationInFrames, "move");
                      }}
                      onContextMenu={(e) => {
                        if (!draggable || !clip.clipId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        selectOnly(clip.clipId);
                        setContextMenu({ x: e.clientX, y: e.clientY, clipId: clip.clipId });
                      }}
                      style={{
                        position: "absolute",
                        left,
                        width,
                        top: 3,
                        bottom: 3,
                        background: `color-mix(in oklab, ${color} ${isDragging ? 42 : isHovered ? 30 : 20}%, transparent)`,
                        border: isSelected ? `1px solid ${color}` : `0.5px solid color-mix(in oklab, ${color} ${isDragging ? 80 : isHovered ? 60 : 40}%, transparent)`,
                        boxShadow: isSelected ? `0 0 0 1px color-mix(in oklab, ${color} 50%, transparent)` : isDragging ? "0 4px 12px rgba(0,0,0,0.4)" : "none",
                        borderRadius: 3,
                        overflow: "hidden",
                        cursor: isDragging ? "grabbing" : draggable && altHeld && canSplit ? SCISSORS_CURSOR : draggable ? "grab" : "default",
                        transition: isDragging ? "none" : "background 100ms, border-color 100ms",
                        zIndex: isDragging ? 5 : isSelected ? 3 : 1,
                        touchAction: draggable ? "none" : undefined,
                        userSelect: "none",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 6px", height: "100%", overflow: "hidden", pointerEvents: "none" }}>
                        <span className="mono" style={{ fontSize: 9, fontWeight: 600, color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clip.name}</span>
                        {width > 60 && <span className="mono nums" style={{ fontSize: 8, color: "var(--text-3)", whiteSpace: "nowrap" }}>{formatTime(clip.durationInFrames, fps)}</span>}
                      </div>

                      {draggable && clip.clipId && !(altHeld && canSplit) && (isHovered || isDragging || isSelected) && (
                        <>
                          <div
                            onPointerDown={(e) => clip.clipId && startDrag(e, clip.clipId, clip.from, clip.durationInFrames, "trim-left")}
                            style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: isDragging && dragState?.mode === "trim-left" ? color : `color-mix(in oklab, ${color} 60%, transparent)`, borderTopLeftRadius: 3, borderBottomLeftRadius: 3, touchAction: "none", zIndex: 2 }}
                          />
                          <div
                            onPointerDown={(e) => clip.clipId && startDrag(e, clip.clipId, clip.from, clip.durationInFrames, "trim-right")}
                            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: isDragging && dragState?.mode === "trim-right" ? color : `color-mix(in oklab, ${color} 60%, transparent)`, borderTopRightRadius: 3, borderBottomRightRadius: 3, touchAction: "none", zIndex: 2 }}
                          />
                        </>
                      )}

                      {isDragging && dragState && (
                        <div style={{ position: "absolute", top: -20, left: 0, padding: "2px 6px", fontSize: 10, fontFamily: "var(--mono)", color: "var(--accent)", background: "rgba(0,0,0,0.7)", border: "0.5px solid var(--accent)", borderRadius: 3, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 10 }}>
                          {dragState.mode === "move" ? "Drop to reorder" : `${formatTime(renderDuration, fps)} (${formatFrames(renderDuration)})`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* No parsed segments — still scrubbable via the ruler. */}
          {lanes.length === 0 && (
            <div style={{ display: "flex", height: TRACK_H * 1.4 }}>
              <div style={{ position: "sticky", left: 0, zIndex: 6, width: LABEL_W, flexShrink: 0, background: "var(--bg-2)", borderRight: "0.5px solid var(--line-1)" }} />
              <div onPointerDown={onLanePointerDown} style={{ position: "relative", width: contentWidth, height: "100%", background: "var(--bg-inset)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-3)", pointerEvents: "none" }}>Scrub to preview · this composition has no separate clips to cut</span>
              </div>
            </div>
          )}

          {snapLine != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: LABEL_W + snapLine * pxPerFrame, width: 1, background: "var(--accent)", opacity: 0.7, zIndex: 4, pointerEvents: "none" }} />}

          {/* Playhead */}
          <div style={{ position: "absolute", top: 0, bottom: 0, left: LABEL_W + currentFrame * pxPerFrame, width: 1, background: "#F86606", zIndex: 5, pointerEvents: "none" }}>
            <div style={{ position: "absolute", top: 0, left: -4, width: 9, height: 9, background: "#F86606", clipPath: "polygon(0 0, 100% 0, 50% 100%)" }} />
          </div>

          {/* Cut preview line (Option held) */}
          {altHeld && canSplit && cutFrame != null && (
            <div style={{ position: "absolute", top: 0, bottom: 0, left: LABEL_W + cutFrame * pxPerFrame, width: 0, borderLeft: "1px dashed #F86606", zIndex: 8, pointerEvents: "none" }}>
              <div style={{ position: "absolute", top: 1, left: -6, color: "#F86606", filter: "drop-shadow(0 0 1px rgba(0,0,0,0.8))" }}>
                <Icon name="scissors" size={11} />
              </div>
            </div>
          )}

          {/* Reorder drop indicator */}
          {insertionFrame != null && (
            <div style={{ position: "absolute", top: RULER_H, bottom: 0, left: LABEL_W + insertionFrame * pxPerFrame - 1, width: 2, background: "var(--accent)", zIndex: 7, pointerEvents: "none", boxShadow: "0 0 6px var(--accent)" }} />
          )}
        </div>
      </div>

      {contextMenu && (
        <>
          <div onPointerDown={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div
            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 61, minWidth: 180, padding: 5, background: "var(--bg-3)", border: "0.5px solid var(--line-2)", borderRadius: "var(--r-sm)", boxShadow: "var(--sh-float)" }}
          >
            {canSplit && (
              <ContextMenuItem icon="scissors" label="Split at playhead" onPick={() => { setContextMenu(null); bladeAtPlayhead(); }} />
            )}
            <ContextMenuItem
              icon="trash"
              label={
                editMode === "segment"
                  ? selectedIds.size > 1 ? `Delete ${selectedIds.size} topics` : "Delete topic"
                  : selectedIds.size > 1 ? `Delete ${selectedIds.size} clips + close gap` : "Delete + close gap"
              }
              onPick={() => { setContextMenu(null); rippleSelected(); }}
            />
            <ContextMenuItem icon="close" label="Deselect" onPick={() => { setContextMenu(null); deselectAll(); }} />
          </div>
        </>
      )}

      <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Timeline shortcuts" width={460}>
        <div style={{ padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 9 }}>
          {[
            ["Play / pause", <Kbd key="sp">Space</Kbd>],
            ["Move playhead 1 frame", <span key="a" style={{ display: "flex", gap: 4 }}><Kbd>←</Kbd><Kbd>→</Kbd></span>],
            ["Jump 10 frames", <span key="s" style={{ display: "flex", gap: 4, alignItems: "center" }}><Kbd>Shift</Kbd>+<Kbd>←</Kbd><Kbd>→</Kbd></span>],
            ["Jump to start / end", <span key="he" style={{ display: "flex", gap: 4 }}><Kbd>Home</Kbd><Kbd>End</Kbd></span>],
            ["Scrub", <span key="cl" style={{ fontSize: 11, color: "var(--text-2)" }}>click / drag the ruler</span>],
            ["Zoom", <span key="z" style={{ display: "flex", gap: 4, alignItems: "center" }}><Kbd>⌘</Kbd>+ scroll</span>],
            ["Split clip at playhead", <Kbd key="sB">S</Kbd>],
            ["Delete clip + close gap", <span key="d" style={{ display: "flex", gap: 4 }}><Kbd>Delete</Kbd></span>],
            ["Select multiple clips", <span key="ms" style={{ display: "flex", gap: 4, alignItems: "center" }}><Kbd>Shift</Kbd>/<Kbd>⌘</Kbd>+ click</span>],
            ["Trim / reorder", <span key="tr" style={{ fontSize: 11, color: "var(--text-2)" }}>drag clip edges / body</span>],
            ["Split at cursor", <span key="alt" style={{ display: "flex", gap: 4, alignItems: "center" }}><Kbd>Alt</Kbd>+ click clip</span>],
            ["Deselect", <Kbd key="esc">Esc</Kbd>],
          ].map(([label, keys], i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 12, color: "var(--text-1)" }}>{label}</span>
              {keys}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

// ── pure helpers ──────────────────────────────────────────────────────────────

function nearestSnap(frame: number, targets: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestDist = threshold + 1;
  for (const t of targets) {
    const d = Math.abs(t - frame);
    if (d <= threshold && d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

function snapTargetsFor(units: EditUnit[], excludeId: string, playhead: number): number[] {
  const s = new Set<number>([0]);
  for (const u of units) {
    if (u.id === excludeId) continue;
    s.add(u.from);
    s.add(u.from + u.durationInFrames);
  }
  s.add(Math.round(playhead));
  return [...s].sort((a, b) => a - b);
}

/**
 * One row of the clip context menu. Kept as its own component so the menu's
 * handlers aren't gathered into an array during render — several of them read a
 * ref, which is only safe to touch from an event.
 */
function ContextMenuItem({ icon, label, onPick }: { icon: string; label: string; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", fontSize: 12, background: "transparent", border: "none", color: "var(--text-0)", borderRadius: 4, cursor: "pointer", textAlign: "left" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-4)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon name={icon} size={13} style={{ color: "var(--text-2)" }} />
      {label}
    </button>
  );
}

function reorderIndex(units: EditUnit[], clipId: string, newFrom: number): number {
  const dragged = units.find((u) => u.id === clipId);
  const centre = newFrom + (dragged?.durationInFrames ?? 0) / 2;
  const others = units.filter((u) => u.id !== clipId).sort((a, b) => a.from - b.from);
  let idx = 0;
  for (const o of others) if (centre > o.from + o.durationInFrames / 2) idx++;
  return idx;
}
