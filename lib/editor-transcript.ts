/**
 * Spoken words, located on the timeline.
 *
 * The editor document stores media trims in SECONDS into the source file
 * (lib/editor-doc.ts, "Units"), while everything on the timeline is measured in
 * composition FRAMES. A transcript is a list of source seconds. This module is
 * the bridge — and it is the whole reason an instruction like "cut the dead air"
 * or "trim the bit where he stumbles over the name" can be carried out at all.
 *
 * Everything here is pure: no React, no I/O, no transcription. The caller hands
 * in words that some other layer already produced (lib/transcribe.ts, cached).
 *
 * ── Why this survives editing ────────────────────────────────────────────────
 * A split gives each half its own `sourceIn` (see `splitItem`), so the same
 * formula keeps mapping the right words onto the right half with no bookkeeping.
 * Nothing here stores a frame number; frames are always derived from the item as
 * it currently stands. Cut a clip in three and each piece still knows what is
 * being said inside it.
 */

import type { AudioItem, EditorDoc, EditorItem, Track, VideoItem } from "./editor-doc";
import { hasSource, removeItem, splitItem } from "./editor-doc";
import type { TranscriptWord } from "./transcribe";

/** A spoken word, placed on the timeline. */
export interface TimedWord {
  text: string;
  /** The item this word is heard inside. */
  itemId: string;
  /** Seconds into the SOURCE file. */
  sourceStart: number;
  sourceEnd: number;
  /** Composition frames. `toFrame` is exclusive, like every other span. */
  fromFrame: number;
  toFrame: number;
}

/** A stretch of the timeline with nothing being said. */
export interface SilenceGap {
  fromFrame: number;
  toFrame: number;
  seconds: number;
  /** What was said either side, for a human-readable report. */
  after?: string;
  before?: string;
}

type MediaItem = VideoItem | AudioItem;

function rateOf(item: MediaItem): number {
  const r = item.playbackRate;
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 1;
}

function inOf(item: MediaItem): number {
  const s = item.sourceIn;
  return typeof s === "number" && Number.isFinite(s) ? s : 0;
}

/** Composition frame → the second of the source file playing there. */
export function frameToSourceSecond(item: MediaItem, frame: number, fps: number): number {
  return inOf(item) + ((frame - item.from) / fps) * rateOf(item);
}

/** Second of the source file → the composition frame it plays at. */
export function sourceSecondToFrame(item: MediaItem, sec: number, fps: number): number {
  return item.from + ((sec - inOf(item)) / rateOf(item)) * fps;
}

/**
 * The stretch of the source file this item actually plays.
 *
 * Derived from `durationInFrames` rather than read from `sourceOut`, because
 * `durationInFrames` is what the renderer obeys — if the two ever disagree, the
 * frames win, and the words should follow what you can hear.
 */
export function itemSourceWindow(item: MediaItem, fps: number): { start: number; end: number } {
  const start = inOf(item);
  return { start, end: start + (item.durationInFrames / fps) * rateOf(item) };
}

/** Every item in the document, with the track it sits on. */
export function allItems(doc: EditorDoc): { track: Track; item: EditorItem }[] {
  return doc.tracks.flatMap((track) => track.items.map((item) => ({ track, item })));
}

/**
 * The words audible inside one clip, placed on the timeline.
 *
 * A word that straddles an edge is kept and clamped rather than dropped — half a
 * word is still audible, and losing it would leave a phantom silence exactly at
 * the cut, which is where an automatic trim would then try to cut again.
 */
export function wordsForItem(item: MediaItem, words: TranscriptWord[], fps: number): TimedWord[] {
  const { start, end } = itemSourceWindow(item, fps);
  const itemEnd = item.from + item.durationInFrames;
  const out: TimedWord[] = [];
  for (const w of words) {
    if (w.end <= start || w.start >= end) continue;
    const text = w.text.trim();
    if (!text) continue;
    const fromFrame = Math.max(item.from, Math.round(sourceSecondToFrame(item, w.start, fps)));
    const toFrame = Math.min(itemEnd, Math.round(sourceSecondToFrame(item, w.end, fps)));
    out.push({
      text,
      itemId: item.id,
      sourceStart: w.start,
      sourceEnd: w.end,
      fromFrame,
      toFrame: Math.max(fromFrame + 1, toFrame),
    });
  }
  return out;
}

/**
 * Every spoken word in the document, in the order it is heard.
 *
 * `transcripts` is keyed by ASSET id, not item id — one source file is usually
 * shared by several clips after a few cuts, and each of them takes its own slice
 * of the same transcript.
 */
export function docTranscript(
  doc: EditorDoc,
  transcripts: Record<string, TranscriptWord[]>,
  fps: number,
  opts: { itemId?: string } = {},
): TimedWord[] {
  const out: TimedWord[] = [];
  for (const { track, item } of allItems(doc)) {
    if (!hasSource(item)) continue;
    if (opts.itemId && item.id !== opts.itemId) continue;
    // A muted track is not heard, so it has nothing to say about the edit.
    if (track.muted) continue;
    const words = transcripts[item.assetId];
    if (!words?.length) continue;
    out.push(...wordsForItem(item, words, fps));
  }
  return out.sort((a, b) => a.fromFrame - b.fromFrame || a.toFrame - b.toFrame);
}

/**
 * Stretches with nothing being said, long enough to be worth cutting.
 *
 * `padFrames` leaves a little air either side of the surviving speech. Cutting
 * hard against the waveform clips the attack of the next word and sounds worse
 * than the pause did — the pad is what makes an automatic trim listenable, so it
 * defaults on rather than being something the caller must remember.
 */
export function silenceGaps(
  words: TimedWord[],
  opts: { minSeconds?: number; fps: number; padFrames?: number } = { fps: 30 },
): SilenceGap[] {
  const fps = opts.fps;
  const minSeconds = opts.minSeconds ?? 0.6;
  const pad = Math.max(0, Math.round(opts.padFrames ?? Math.round(fps * 0.08)));
  const minFrames = minSeconds * fps;
  const gaps: SilenceGap[] = [];

  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    // Words can overlap slightly across clips; only a real hole counts.
    const rawFrom = a.toFrame;
    const rawTo = b.fromFrame;
    if (rawTo - rawFrom < minFrames) continue;
    const from = rawFrom + pad;
    const to = rawTo - pad;
    if (to - from < 1) continue;
    gaps.push({
      fromFrame: from,
      toFrame: to,
      seconds: (to - from) / fps,
      after: a.text,
      before: b.text,
    });
  }
  return gaps;
}

/**
 * The words spoken across a stretch of the timeline — what a range actually
 * contains, for confirming a cut before making it.
 */
export function wordsInRange(words: TimedWord[], fromFrame: number, toFrame: number): TimedWord[] {
  return words.filter((w) => w.toFrame > fromFrame && w.fromFrame < toFrame);
}

/**
 * Remove a stretch of the timeline, across EVERY track, and close the hole.
 *
 * This is the one genuinely new editing operation, and the ripple is why it
 * exists. `rippleRemoveItem` (lib/editor-doc.ts) slides only the item's own
 * track, which is right for dragging one clip out of a row. Applying that to a
 * transcript cut would leave the music bed and the titles where they were while
 * the footage underneath them got shorter — every layer would silently drift out
 * of sync with the words it was cut against, and the damage compounds with every
 * further cut. So the shift is document-wide or it is nothing.
 *
 * Items straddling either edge are split first, so a cut can land in the middle
 * of a clip without the caller doing any bookkeeping.
 */
export function cutRange(
  doc: EditorDoc,
  fromFrame: number,
  toFrame: number,
  fps: number,
  opts: { ripple?: boolean } = {},
): EditorDoc {
  const start = Math.max(0, Math.round(Math.min(fromFrame, toFrame)));
  const end = Math.round(Math.max(fromFrame, toFrame));
  const span = end - start;
  if (span <= 0) return doc;

  let next = doc;

  // 1 — Split everything that crosses an edge. Re-scan after each split: the
  //     tail gets a fresh id, so a list captured up front would go stale.
  for (const edge of [start, end]) {
    for (let guard = 0; guard < 500; guard++) {
      const straddler = allItems(next).find(
        ({ item }) => item.from < edge && item.from + item.durationInFrames > edge,
      );
      if (!straddler) break;
      const after = splitItem(next, straddler.item.id, edge, fps);
      // splitItem returns the document untouched when it refuses. Bail rather
      // than spin — the caller gets a no-op, never a hang.
      if (after === next) break;
      next = after;
    }
  }

  // 2 — Drop what now lies wholly inside the range.
  for (let guard = 0; guard < 500; guard++) {
    const inside = allItems(next).find(
      ({ item }) => item.from >= start && item.from + item.durationInFrames <= end,
    );
    if (!inside) break;
    next = removeItem(next, inside.item.id);
  }

  if (opts.ripple === false) return next;

  // 3 — Close the hole on every track at once, so nothing drifts.
  return {
    ...next,
    tracks: next.tracks.map((t) => ({
      ...t,
      items: t.items.map((i) => (i.from >= end ? { ...i, from: Math.max(0, i.from - span) } : i)),
    })),
  };
}
