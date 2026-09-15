import { parseDataTimeline, parseSegments } from "./data-timeline";
import { normalizeSeriesToSequences, parseSequenceBlocks, parseTransitionSeries } from "./timeline-parser";
import type { CutPlan } from "./cut-plan";
import {
  emptyDoc, fullFrameLayout, makeId,
  type Asset, type DocSize, type EditorDoc, type EditorItem, type SceneItem, type VideoItem,
} from "./editor-doc";

export interface ImportOptions {
  /** Source file length in seconds, so the timeline can window its filmstrip. */
  sourceDurationSec?: number;
  /** The generated composition's own length — needed to derive card spans. */
  compositionDurationInFrames?: number;
}

/** The one media file these edits play from. */
function findSource(code: string): string | null {
  return /["'`](\/api\/media\/[^"'`]+)["'`]/.exec(code)?.[1] ?? null;
}

/**
 * A block that keeps rendering the original composition, showing only its own
 * stretch of it. This is how branded animated title cards survive the import:
 * the whole generated scene is embedded and windowed, so nothing has to be
 * parsed out of it and nothing is redrawn by hand.
 *
 * `offset` is which frame of the embedded composition the block opens on. It is
 * separate from `from` because the two only coincide when the blocks tile the
 * composition from frame zero — true for a whole-composition import, not true in
 * general.
 */
export function windowedSceneItem(
  code: string,
  size: DocSize,
  from: number,
  durationInFrames: number,
  offset: number,
): SceneItem {
  return {
    type: "scene",
    id: makeId("card"),
    from,
    durationInFrames: Math.max(1, durationInFrames),
    layout: fullFrameLayout(size),
    code,
    sourceOffsetFrames: Math.max(0, offset),
  };
}

/** A card in an interview edit: tiled from zero, so its window is its position. */
function cardBlock(code: string, size: DocSize, from: number, durationInFrames: number): SceneItem {
  return windowedSceneItem(code, size, from, durationInFrames, from);
}

function footageBlock(
  size: DocSize,
  assetId: string,
  from: number,
  durationInFrames: number,
  sourceIn: number,
  sourceOut: number,
): VideoItem {
  return {
    type: "video",
    id: makeId("video"),
    from,
    durationInFrames: Math.max(1, durationInFrames),
    layout: fullFrameLayout(size),
    assetId,
    sourceIn,
    sourceOut,
  };
}

/**
 * Turn a Smart-trim cut plan into an editable timeline.
 *
 * The mapping is direct because both sides already speak the same units: a
 * `KeepRange` is seconds into the source, and a media item stores `sourceIn` /
 * `sourceOut` in seconds too. Each kept range becomes one clip, laid end to end.
 *
 * This is strictly better than the code the same plan used to generate. There,
 * the whole cut arrived as one `<Series>` of hard-coded trims — a finished
 * artefact you could regenerate with different thresholds but not actually edit.
 * Here every kept range is a clip you can drag, retrim, split or delete, and the
 * gaps the planner removed are simply the frames between them.
 */
export function docFromCutPlan(
  plan: CutPlan,
  size: DocSize,
  src: string,
  opts: { name?: string; sourceDurationSec?: number } = {},
): EditorDoc | null {
  if (!plan?.ranges?.length) return null;

  const asset: Asset = {
    id: makeId("asset"),
    kind: "video",
    src,
    name: opts.name ?? src.split("/").pop() ?? "footage",
    durationSec: opts.sourceDurationSec ?? plan.originalDuration,
  };

  let cursor = 0;
  const items: EditorItem[] = [];
  for (const range of plan.ranges) {
    // A range shorter than a frame would round to zero and be dropped by the
    // no-overlap invariant; keep it at one frame rather than losing the cut.
    const durationInFrames = Math.max(1, Math.round((range.to - range.from) * size.fps));
    items.push(footageBlock(size, asset.id, cursor, durationInFrames, range.from, range.to));
    cursor += durationInFrames;
  }

  const base = emptyDoc(size);
  return {
    ...base,
    assets: [asset],
    tracks: [{ id: makeId("track"), name: "Cut", items }],
  };
}

/**
 * Open a generated interview/tutorial edit as editable blocks, at the positions
 * the generator gave them.
 *
 * Answers become real video clips — trimmable, extendable, with filmstrips —
 * because that is what you actually recut. Title and end cards stay as windows
 * onto the original composition, so they keep their design and animation.
 *
 * The result plays like the original; what changes is that you can now move the
 * pieces. Returns null when the edit has no structure to recover, in which case
 * the caller should fall back to embedding it whole (`docFromScene`).
 */
export function docFromVideoEdit(
  code: string,
  size: DocSize,
  opts: ImportOptions = {},
): EditorDoc | null {
  const src = findSource(code);
  if (!src) return null;

  const asset: Asset = {
    id: makeId("asset"),
    kind: "video",
    src,
    name: src.split("/").pop() ?? "footage",
    durationSec: opts.sourceDurationSec,
  };

  const items = buildFromDataTimeline(code, size, asset.id, opts)
    ?? buildFromSegments(code, size, asset.id, opts);
  if (!items || items.length === 0) return null;

  const base = emptyDoc(size);
  return {
    ...base,
    assets: [asset],
    tracks: [{ id: makeId("track"), name: "Edit", items }],
  };
}

/**
 * Preferred path: the driving array labels each element (card / answer / end)
 * and the model computes where each one sits, so every block can be placed at
 * its original position and given the right treatment.
 */
function buildFromDataTimeline(
  code: string,
  size: DocSize,
  assetId: string,
  opts: ImportOptions,
): EditorItem[] | null {
  const dt = parseDataTimeline(code, size.fps, opts.compositionDurationInFrames ?? 0);
  if (!dt) return null;
  const answers = dt.clips.filter((c) => c.kind === "answer" && c.startSec != null && c.endSec != null);
  if (answers.length === 0) return null;

  return dt.clips.map((clip) =>
    clip.kind === "answer" && clip.startSec != null && clip.endSec != null
      ? footageBlock(size, assetId, clip.from, clip.durationInFrames, clip.startSec, clip.endSec)
      : cardBlock(code, size, clip.from, clip.durationInFrames),
  );
}

/**
 * Fallback: the array holds only the topics, and the cards between them are
 * generated by the composition's own loop. Their length is whatever is left over
 * once the answers are accounted for — the same arithmetic the existing topic
 * timeline uses — which is enough to window each card out of the original.
 */
function buildFromSegments(
  code: string,
  size: DocSize,
  assetId: string,
  opts: ImportOptions,
): EditorItem[] | null {
  const sa = parseSegments(code, size.fps);
  if (!sa || sa.segments.length === 0) return null;

  const answerFrames = sa.segments.map((s) =>
    Math.max(1, Math.round((s.endSec - s.startSec) * size.fps)),
  );
  const total = opts.compositionDurationInFrames ?? 0;
  const leftover = total - answerFrames.reduce((a, b) => a + b, 0);
  const n = sa.segments.length;
  const hasCards = total > 0 && leftover >= n;
  // Spread the remainder over the first few cards rather than rounding each one,
  // so the blocks add up to the original composition exactly. A couple of frames
  // of drift would push every later card off the frame it is windowed onto.
  const baseCard = hasCards ? Math.floor(leftover / n) : 0;
  const extra = hasCards ? leftover % n : 0;

  const items: EditorItem[] = [];
  let cursor = 0;
  sa.segments.forEach((seg, i) => {
    const cardFrames = baseCard + (i < extra ? 1 : 0);
    if (cardFrames > 0) {
      items.push(cardBlock(code, size, cursor, cardFrames));
      cursor += cardFrames;
    }
    items.push(footageBlock(size, assetId, cursor, answerFrames[i], seg.startSec, seg.endSec));
    cursor += answerFrames[i];
  });
  return items;
}

/** One block's stretch of the composition, in composition frames. */
export interface CompositionSpan {
  from: number;
  durationInFrames: number;
}

/**
 * Where an animation's cuts fall.
 *
 * The old code timeline had to be strict about this, because it REWROTE the
 * composition and a bad read corrupted the file. Windowing has no such risk —
 * every block embeds the whole composition and shows its own stretch — so this
 * only has to know where the cuts are, which is why it reaches compositions the
 * old parser refused to edit.
 *
 * Returns null when nothing usable is found, so the caller falls back to
 * embedding the composition whole.
 */
export function compositionSpans(
  code: string,
  fps: number,
  exportedDurationInFrames: number,
): CompositionSpan[] | null {
  if (!code?.trim() || !(exportedDurationInFrames > 0)) return null;

  // TransitionSeries first: it is the only parser whose positions already account
  // for the overlap a crossfade steals from the preceding slot.
  const ts = parseTransitionSeries(code, fps);
  let starts: number[] | null = null;
  let contentEnd = 0;

  if (ts && ts.children.length > 0) {
    starts = ts.children.map((c) => c.from);
    contentEnd = ts.totalDurationInFrames;
  } else {
    // A <Series> lays its children out implicitly; flattening gives them the
    // explicit positions this needs. Only the POSITIONS come from the flattened
    // source — the blocks still embed the original, unflattened composition.
    const flat = normalizeSeriesToSequences(code, fps) ?? code;
    const blocks = parseSequenceBlocks(flat, fps);
    if (blocks.length > 0) {
      starts = blocks.map((b) => b.from);
      contentEnd = Math.max(...blocks.map((b) => b.from + b.durationInFrames));
    }
  }
  // Deliberately NOT parseTimeline: it drops a TransitionSeries.Sequence whose
  // body is a bare <HeroScene />, because it insists on finding markup inside.
  if (!starts || starts.length === 0) return null;

  // Roughly half of these compositions declare a durationInFrames shorter than
  // their own content, because the export miscounts the transition overlaps —
  // which means their last scene never plays. Cover the real content rather
  // than reproducing that: a scene you cannot see is a scene you cannot fix.
  const end = Math.max(exportedDurationInFrames, contentEnd);
  const spans = spansFromStarts(starts, end);
  // One span is just the whole composition — that is docFromScene's job, and
  // saying so here keeps the caller's fallback meaningful.
  return spans.length >= 2 ? spans : null;
}

/**
 * Turn clip start frames into blocks that tile the composition exactly.
 *
 * Parsed clips OVERLAP wherever there is a crossfade, but a track may not hold
 * overlapping items — `isValidDoc` rejects it and `addItem` would silently shunt
 * the later one along, quietly wrecking the timing. So the starts become cut
 * points and each block runs to the next one. Nothing is lost: the blended
 * frames still live inside whichever window covers them, because every window
 * renders the whole composition.
 *
 * Anchored on the composition's EXPORTED duration, which is what the player and
 * the renderer use. The parsers' own total disagrees with it on most projects —
 * the export usually miscounts its overlaps — and trusting the parser instead
 * would cut the tail off or pad it with black.
 */
function spansFromStarts(starts: number[], exportedDurationInFrames: number): CompositionSpan[] {
  const points = [...new Set(starts.map((n) => Math.max(0, Math.round(n))))]
    .filter((n) => n < exportedDurationInFrames)
    .sort((a, b) => a - b);
  // Anything before the first cut is its own block, so a composition that opens
  // outside its series keeps its head.
  if (points[0] !== 0) points.unshift(0);

  const spans: CompositionSpan[] = [];
  for (let i = 0; i < points.length; i++) {
    const from = points[i];
    const end = i + 1 < points.length ? points[i + 1] : exportedDurationInFrames;
    if (end - from >= 1) spans.push({ from, durationInFrames: end - from });
  }
  // The last block always runs to the exported end, even if rounding lost a frame.
  const last = spans[spans.length - 1];
  if (last) last.durationInFrames = Math.max(1, exportedDurationInFrames - last.from);
  return spans;
}

/**
 * Open ANY composition as editable blocks.
 *
 * `docFromVideoEdit` recovers an interview cut and needs a video file to do it;
 * this is the animation case, where there is no footage at all — a TransitionSeries
 * of branded scenes, or a handful of Sequences. Each cut becomes a block you can
 * move, trim, split and layer, and every block still renders the original
 * composition, so nothing is parsed out and nothing is redrawn.
 *
 * Returns null when the composition has no cuts to find — a continuous scroll,
 * say — in which case one block IS the honest representation and the caller
 * falls back to `docFromScene`.
 */
export function docFromComposition(
  code: string,
  size: DocSize,
  exportedDurationInFrames: number,
): EditorDoc | null {
  const spans = compositionSpans(code, size.fps, exportedDurationInFrames);
  if (!spans) return null;

  const base = emptyDoc(size);
  return {
    ...base,
    tracks: [
      {
        id: makeId("track"),
        name: "Scenes",
        // Tiled from frame zero, so each block's window offset IS its position.
        items: spans.map((s) => windowedSceneItem(code, size, s.from, s.durationInFrames, s.from)),
      },
    ],
  };
}

/**
 * Topics whose footage range is implausibly short. The generator occasionally
 * writes a range like 125.1 → 125.2, which renders as a few frames — invisible
 * in the finished video and easy to miss until you see the blocks laid out.
 */
export function suspiciousSegments(
  code: string,
  fps: number,
  minSeconds = 1,
): { label: string; seconds: number }[] {
  const segments = parseSegments(code, fps);
  if (!segments) return [];
  return segments.segments
    .map((s) => ({ label: s.label, seconds: s.endSec - s.startSec }))
    .filter((s) => s.seconds < minSeconds);
}
