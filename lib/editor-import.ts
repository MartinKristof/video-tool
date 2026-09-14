import { parseDataTimeline, parseSegments } from "./data-timeline";
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
 */
function cardBlock(code: string, size: DocSize, from: number, durationInFrames: number): SceneItem {
  return {
    type: "scene",
    id: makeId("card"),
    from,
    durationInFrames: Math.max(1, durationInFrames),
    layout: fullFrameLayout(size),
    code,
    sourceOffsetFrames: from,
  };
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
