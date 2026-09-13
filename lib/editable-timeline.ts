import {
  parseTimeline,
  parseSequenceBlocks,
  normalizeSeriesToSequences,
} from "./timeline-parser";

/**
 * The "editable timeline" is a structured doc that round-trips with code via
 * docFromCode / codeFromDoc. We use it for direct-manipulation drag/trim/split
 * on top of the existing parseSequenceBlocks foundation.
 *
 * ONE mode: every edit is a byte-patch of the original source. Only the numeric
 * attribute slices we mapped are rewritten, so imports, styling, authored JSX,
 * <Audio> and overlays survive an edit byte-for-byte.
 *
 * This replaced an earlier "video mode" that regenerated the whole file from the
 * doc. That emitter could only round-trip `<Sequence><Video/></Sequence>`, so
 * any composition holding audio or overlays had to be refused as read-only to
 * avoid destroying it — which is why a plain interview edit with music used to
 * be frozen. Nothing is regenerated now, so nothing has to be refused.
 */

export interface EditableClip {
  id: string;
  kind: "video" | "audio" | "scene";
  /** Name shown on the clip in the timeline. */
  label: string;
  /**
   * Magnetic base track vs free track. The base track is gapless — ripple and
   * reorder re-pack it, as an NLE does. Free tracks (audio beds, captions over
   * footage) hold their own position and may overlap; they only move when a
   * base-track ripple shifts everything after it, so music and captions stay in
   * sync with the footage they sit under.
   */
  track: "base" | "free";
  // Media clips only — undefined for scenes.
  src?: string;
  from: number; // frames into the composition
  durationInFrames: number;
  startFrom?: number; // trim start in source media (frames)
  endAt?: number; // trim end in source media (frames)
  // Video mode only — the source file's native fps (from ffprobe). Trim/split
  // convert composition-frame deltas to source-frame deltas using this, because
  // startFrom/endAt are counted in SOURCE frames while from/durationInFrames are
  // COMPOSITION frames. Undefined ⇒ assume native fps == composition fps.
  nativeFps?: number;
  // Video mode only — the source file's last frame (ffprobe nbFrames). A trim can
  // never extend endAt past this, so a clip can't read into frozen/black frames.
  maxSourceFrame?: number;
  // Byte offsets into `EditableDoc.originalCode` for the whole
  // `<Sequence>...</Sequence>` block and the attribute value slices.
  sourceRange?: { start: number; end: number };
  fromAttrRange?: { start: number; end: number };
  durationAttrRange?: { start: number; end: number };
  // Media clips only — the source-trim attribute slices inside the <Video>/
  // <Audio> tag, and where to splice one in when the attribute is absent (a
  // clip written without `startFrom` still needs one once it is trimmed).
  startFromAttrRange?: { start: number; end: number };
  endAtAttrRange?: { start: number; end: number };
  mediaAttrInsertAt?: number;
}

export interface EditableDoc {
  mode: "patch";
  fps: number;
  clips: EditableClip[];
  totalDurationInFrames: number;
  // The source that every offset in `clips[*].*Range` points into.
  originalCode: string;
}

function makeId(srcOrTag: string, index: number): string {
  const safe = srcOrTag.replace(/[^a-zA-Z0-9]/g, "_").slice(-24);
  return `${safe}_${index}`;
}

/**
 * Returns null if the code doesn't contain a recognisable, editable
 * composition. Falls back to read-only for mixed video+scene compositions and
 * for compositions using TransitionSeries.Sequence / Series.Sequence (those
 * have implicit `from` derived from running totals — patching one attribute
 * can't reposition the rest).
 */
export function docFromCode(
  code: string,
  fps: number,
  nativeFpsBySrc?: Record<string, number>,
  maxSrcFrameBySrc?: Record<string, number>,
): EditableDoc | null {
  if (!code || !code.trim()) return null;

  // TransitionSeries gives each child an implicit position derived from a
  // running total with frame overlaps, so patching one attribute can't
  // reposition the rest. Correlating those to editable entries is separate work
  // (roadmap 1c) — stay read-only rather than mis-cut.
  if (/<TransitionSeries\b/.test(code)) return null;

  // Smart Trim writes <Series>, whose children also carry implicit positions.
  // Flatten it once into explicit <Sequence from={…}> blocks so there is a
  // single shape to patch. Null ⇒ a Series shape we don't understand.
  let source = code;
  if (/<Series\s*>/.test(code)) {
    const flat = normalizeSeriesToSequences(code, fps);
    if (!flat) return null;
    source = flat;
  }

  const blocks = parseSequenceBlocks(source, fps);
  if (blocks.length === 0) return null;
  // Can't round-trip arithmetic like `from={INTRO + 30}` losslessly.
  if (blocks.some((b) => b.hasNonNumericFrom || b.hasNonNumericDuration)) return null;
  // A media leaf whose trim attributes we couldn't map must not be patched blind.
  if (blocks.some((b) => b.mediaUnmappable)) return null;

  // The base track is whatever carries the composition: the footage when there
  // is any, otherwise the scenes themselves (animation / broll / svg projects).
  const baseKind: "video" | "scene" = blocks.some((b) => b.kind === "video")
    ? "video"
    : "scene";

  const clips: EditableClip[] = blocks.map((b, i) => ({
    id: makeId(b.src ?? b.kind, i),
    kind: b.kind,
    label: b.label,
    track: b.kind === baseKind ? "base" : "free",
    src: b.src,
    from: b.from,
    durationInFrames: b.durationInFrames,
    startFrom: b.startFrom,
    endAt: b.endAt,
    // Audio trim is counted at composition fps, so it is deliberately left
    // without a native fps and converts 1:1.
    nativeFps: b.kind === "video" && b.src ? nativeFpsBySrc?.[b.src] : undefined,
    maxSourceFrame: b.kind === "video" && b.src ? maxSrcFrameBySrc?.[b.src] : undefined,
    sourceRange: { start: b.blockStart, end: b.blockEnd },
    fromAttrRange: { start: b.fromValueStart, end: b.fromValueEnd },
    durationAttrRange: { start: b.durationValueStart, end: b.durationValueEnd },
    startFromAttrRange: b.startFromRange ?? undefined,
    endAtAttrRange: b.endAtRange ?? undefined,
    mediaAttrInsertAt: b.mediaAttrInsertAt,
  }));

  const totalDurationInFrames = Math.max(
    0,
    ...clips.map((c) => c.from + c.durationInFrames),
  );

  return { mode: "patch", fps, clips, totalDurationInFrames, originalCode: source };
}

/**
 * Convert a composition-frame delta into a source-media-frame delta for a clip.
 * `startFrom`/`endAt` are counted in the source file's native fps, while drag
 * deltas arrive in composition frames — so they must be scaled when the two fps
 * differ. Falls back to 1:1 when the native fps is unknown or equal.
 */
function compDeltaToSource(clip: EditableClip, deltaComp: number, compFps: number): number {
  const native = clip.nativeFps;
  if (!native || native === compFps || compFps <= 0) return deltaComp;
  return Math.round((deltaComp * native) / compFps);
}

/** Inverse of compDeltaToSource: source frames → composition frames. */
function sourceDeltaToComp(clip: EditableClip, deltaSource: number, compFps: number): number {
  const native = clip.nativeFps;
  if (!native || native === compFps || native <= 0) return deltaSource;
  return Math.round((deltaSource * compFps) / native);
}

/**
 * Editability with a human-readable reason. When `docFromCode` returns null we
 * classify WHY so the timeline can tell the user (e.g. "blended transitions")
 * instead of silently disabling editing. Navigation (scrub/zoom/playhead) still
 * works regardless of the reason.
 */
export function analyzeEditability(
  code: string,
  fps: number,
  nativeFpsBySrc?: Record<string, number>,
  maxSrcFrameBySrc?: Record<string, number>,
): { doc: EditableDoc | null; reason: string | null } {
  const doc = docFromCode(code, fps, nativeFpsBySrc, maxSrcFrameBySrc);
  if (doc) return { doc, reason: null };
  if (!code || !code.trim()) return { doc: null, reason: null };
  if (parseTimeline(code, fps).length === 0) return { doc: null, reason: null };

  if (/<TransitionSeries\b/.test(code)) {
    return { doc: null, reason: "Blended transitions — edit via chat or the code panel" };
  }
  if (/<Series\s*>/.test(code) && !normalizeSeriesToSequences(code, fps)) {
    return { doc: null, reason: "Series layout we can't map — edit via chat or the code panel" };
  }
  const blocks = parseSequenceBlocks(code, fps);
  if (blocks.some((b) => b.mediaUnmappable)) {
    return { doc: null, reason: "Clip trim isn't a plain number — edit via chat or the code panel" };
  }
  return { doc: null, reason: "Uses calculated timings — edit via chat or the code panel" };
}

/**
 * Emit code by patching the original source. Only the numeric attribute slices
 * we mapped are rewritten, so every other byte the AI (or Filip) wrote — the
 * imports, the styling, the authored JSX, <Audio>, overlays — survives an edit
 * exactly as it was.
 */
export function codeFromDoc(doc: EditableDoc): string {
  return applyEdits(doc.originalCode, collectClipEdits(doc.clips), totalOf(doc.clips));
}

type Edit = { start: number; end: number; replacement: string };

/** Splice edits into `src` right-to-left so earlier offsets stay valid. */
function applyEdits(src: string, edits: Edit[], total?: number): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  if (total != null) out = setDurationExport(out, total);
  return out;
}

/**
 * Keep `export const durationInFrames` in step so the player extends to fit.
 * The value is replaced up to the `;` rather than just a bare integer, because
 * generated compositions often declare it as a sum of scene constants
 * (`SCENE_1 + SCENE_2 + …`), sometimes on the next line. Every Sequence
 * duration we patch is already a literal — docFromCode refuses a composition
 * whose attributes aren't — so collapsing the export to a literal keeps the two
 * in agreement instead of letting them silently drift apart.
 */
function setDurationExport(code: string, total: number): string {
  return code.replace(
    /(export\s+(?:const|let|var)\s+durationInFrames\s*=\s*)[^;]+/,
    `$1${total}`,
  );
}

function totalOf(clips: EditableClip[]): number {
  return Math.max(1, ...clips.map((c) => c.from + c.durationInFrames));
}

/**
 * Attribute patches for a set of clips: position/duration on the <Sequence>,
 * plus the source trim on the media tag inside it. A trim value that has no
 * attribute yet (a clip written without `startFrom`) is spliced in.
 */
function collectClipEdits(clips: EditableClip[]): Edit[] {
  const edits: Edit[] = [];
  for (const c of clips) {
    if (!c.fromAttrRange || !c.durationAttrRange) continue;
    edits.push({ ...c.fromAttrRange, replacement: String(c.from) });
    edits.push({ ...c.durationAttrRange, replacement: String(c.durationInFrames) });
    pushTrimEdit(edits, c, "startFrom", c.startFrom, c.startFromAttrRange);
    pushTrimEdit(edits, c, "endAt", c.endAt, c.endAtAttrRange);
  }
  return edits;
}

function pushTrimEdit(
  edits: Edit[],
  clip: EditableClip,
  attr: "startFrom" | "endAt",
  value: number | undefined,
  range: { start: number; end: number } | undefined,
) {
  if (range) {
    // Present in the source: patch it, or blank the whole attribute if the
    // trim went away. (Blanking is rare — trims only ever move.)
    if (value == null) return;
    edits.push({ ...range, replacement: String(value) });
    return;
  }
  if (value == null || clip.mediaAttrInsertAt == null) return;
  // Absent: splice a new attribute into the media tag. This is what lets a clip
  // the AI wrote without any trim be trimmed on the timeline at all.
  edits.push({
    start: clip.mediaAttrInsertAt,
    end: clip.mediaAttrInsertAt,
    replacement: `${attr}={${value}} `,
  });
}

export function moveClip(doc: EditableDoc, clipId: string, deltaFrames: number): EditableDoc {
  const clips = doc.clips.map((c) =>
    c.id === clipId ? { ...c, from: Math.max(0, c.from + deltaFrames) } : c,
  );
  const totalDurationInFrames = Math.max(
    0,
    ...clips.map((c) => c.from + c.durationInFrames),
  );
  return { ...doc, clips, totalDurationInFrames };
}

/**
 * Shift every clip that starts after `afterFrom` by `delta`, so a trim or a
 * delete ripples through without disturbing the spacing between clips. Gaps and
 * deliberate overlaps (crossfades) are preserved exactly — re-packing from zero
 * would silently flatten them.
 */
function rippleAfter(clips: EditableClip[], afterFrom: number, delta: number): EditableClip[] {
  if (delta === 0) return clips;
  return clips.map((c) =>
    c.from > afterFrom ? { ...c, from: Math.max(0, c.from + delta) } : c,
  );
}

/**
 * Drag right edge: shrink/grow the clip from its tail, keeping `from` fixed and
 * rippling everything after it. For media clips with a tail-trim (`endAt`) the
 * trim moves by the same amount so the source stays consistent.
 */
export function trimClipRight(doc: EditableDoc, clipId: string, deltaFrames: number): EditableDoc {
  const clip = doc.clips.find((c) => c.id === clipId);
  if (!clip) return doc;

  let newDuration = Math.max(1, clip.durationInFrames + deltaFrames);
  // Clamp growth so the clip can't read past the source's last frame (which
  // would render a frozen/black tail). Works whether or not endAt is present:
  // the current source-out is endAt, else startFrom + (duration in source frames).
  if (clip.maxSourceFrame != null) {
    const currentSourceEnd =
      clip.endAt != null
        ? clip.endAt
        : (clip.startFrom ?? 0) + compDeltaToSource(clip, clip.durationInFrames, doc.fps);
    const maxGrowthSource = Math.max(0, clip.maxSourceFrame - currentSourceEnd);
    const maxDuration = clip.durationInFrames + sourceDeltaToComp(clip, maxGrowthSource, doc.fps);
    if (newDuration > maxDuration) newDuration = Math.max(1, maxDuration);
  }
  const actualDelta = newDuration - clip.durationInFrames;
  if (actualDelta === 0) return doc;

  const trimmed = doc.clips.map((c) =>
    c.id !== clipId
      ? c
      : {
          ...c,
          durationInFrames: newDuration,
          endAt: c.endAt != null ? c.endAt + compDeltaToSource(c, actualDelta, doc.fps) : c.endAt,
        },
  );
  // Only the magnetic base track ripples. Shortening a music bed or a caption
  // must leave the footage exactly where it is.
  const clips =
    clip.track === "base" ? rippleAfter(trimmed, clip.from, actualDelta) : trimmed;
  return {
    ...doc,
    clips,
    totalDurationInFrames: Math.max(0, ...clips.map((c) => c.from + c.durationInFrames)),
  };
}

/**
 * Drag left edge: eat into the clip's head and pull everything after it back —
 * a ripple trim, so no gap opens up. For media clips the head trim advances
 * `startFrom`, so the same frame plays after the drag; a clip written without a
 * `startFrom` gets one (the emitter splices it in). Scenes have no source trim:
 * each renders from frame 0 of its own Sequence, so trimming left just makes
 * the scene shorter.
 */
export function trimClipLeft(doc: EditableDoc, clipId: string, deltaFrames: number): EditableDoc {
  const clip = doc.clips.find((c) => c.id === clipId);
  if (!clip) return doc;

  const startFromBase = clip.startFrom ?? 0;
  // Leftward growth is bounded by how much un-trimmed source HEAD exists
  // (startFromBase, in source frames — converted so both limits share a unit).
  const native = clip.nativeFps && clip.nativeFps > 0 ? clip.nativeFps : doc.fps;
  const startFromBaseComp = Math.floor((startFromBase * doc.fps) / native);
  const maxLeftGrowth = clip.kind === "scene" ? clip.from : Math.min(clip.from, startFromBaseComp);
  const clamped = Math.max(-maxLeftGrowth, Math.min(clip.durationInFrames - 1, deltaFrames));
  if (clamped === 0) return doc;

  // On the base track the clip stays anchored and everything after it ripples
  // left. A free-track clip has nothing to ripple, so its own `from` moves
  // instead — either way the clip's right edge stays put.
  const isBase = clip.track === "base";
  const trimmed = doc.clips.map((c) =>
    c.id !== clipId
      ? c
      : {
          ...c,
          from: isBase ? c.from : c.from + clamped,
          durationInFrames: c.durationInFrames - clamped,
          startFrom:
            c.kind === "scene"
              ? c.startFrom
              : startFromBase + compDeltaToSource(c, clamped, doc.fps),
        },
  );
  const clips = isBase ? rippleAfter(trimmed, clip.from, -clamped) : trimmed;
  return {
    ...doc,
    clips,
    totalDurationInFrames: Math.max(0, ...clips.map((c) => c.from + c.durationInFrames)),
  };
}

/**
 * Split a clip at `atFrame` (absolute composition frame). For scene clips,
 * duplicates the Sequence text block so the user's JSX is preserved on both
 * halves; the doc is re-derived from the rewritten code so attribute offsets
 * stay accurate for subsequent edits.
 */
export function splitClip(
  doc: EditableDoc,
  clipId: string,
  atFrame: number,
): EditableDoc {
  const clip = doc.clips.find((c) => c.id === clipId);
  if (!clip || !clip.sourceRange) return doc;
  const localFrame = atFrame - clip.from;
  if (localFrame <= 0 || localFrame >= clip.durationInFrames) return doc;

  const original = doc.originalCode;
  const headDuration = localFrame;
  const tailFrom = clip.from + localFrame;
  const tailDuration = clip.durationInFrames - localFrame;

  // Where the cut lands in the SOURCE media. The head stops there and the tail
  // resumes from there, so the two halves play the same footage the single clip
  // did. Scenes have no source trim — each half just renders its own span.
  const srcDelta = compDeltaToSource(clip, localFrame, doc.fps);
  const isMedia = clip.kind !== "scene";
  const cutSourceFrame = (clip.startFrom ?? 0) + srcDelta;
  // Only narrow the head's tail-trim if it had one; otherwise its Sequence
  // duration already clips it.
  const headEndAt = isMedia && clip.endAt != null ? cutSourceFrame : clip.endAt;
  const tailStartFrom = isMedia ? cutSourceFrame : undefined;

  // 1. Patch every clip, the split one carrying the HEAD half's values.
  const headClips = doc.clips.map((c) =>
    c.id === clipId
      ? { ...c, durationInFrames: headDuration, endAt: headEndAt }
      : c,
  );
  const patched = applyEdits(original, collectClipEdits(headClips));

  // 2. Re-locate the split block by re-parsing (offsets moved). Blocks come back
  // in source order, so index by source position — `doc.clips` may have been
  // re-ordered by a previous reorder/repack and no longer match.
  const reparsed = parseSequenceBlocks(patched, doc.fps);
  const sourceOrder = [...doc.clips].sort(
    (a, b) => (a.sourceRange?.start ?? 0) - (b.sourceRange?.start ?? 0),
  );
  const splitIdx = sourceOrder.findIndex((c) => c.id === clipId);
  const splitBlock = reparsed[splitIdx];
  if (!splitBlock) return doc;

  // 3. Duplicate the (already head-patched) block as the tail half, rewriting
  // its attributes at block-relative offsets. Duplicating the text is what keeps
  // authored JSX intact on both halves.
  const headText = patched.slice(splitBlock.blockStart, splitBlock.blockEnd);
  const rel = (r: { start: number; end: number }) => ({
    start: r.start - splitBlock.blockStart,
    end: r.end - splitBlock.blockStart,
  });
  const tailEdits: Edit[] = [
    {
      ...rel({ start: splitBlock.fromValueStart, end: splitBlock.fromValueEnd }),
      replacement: String(tailFrom),
    },
    {
      ...rel({ start: splitBlock.durationValueStart, end: splitBlock.durationValueEnd }),
      replacement: String(tailDuration),
    },
  ];
  if (tailStartFrom != null) {
    if (splitBlock.startFromRange) {
      tailEdits.push({ ...rel(splitBlock.startFromRange), replacement: String(tailStartFrom) });
    } else if (splitBlock.mediaAttrInsertAt != null) {
      const at = splitBlock.mediaAttrInsertAt - splitBlock.blockStart;
      tailEdits.push({ start: at, end: at, replacement: `startFrom={${tailStartFrom}} ` });
    }
    // The block we duplicated already carries the HEAD's narrowed endAt, so the
    // tail has to be given the original out-point back.
    if (clip.endAt != null && splitBlock.endAtRange) {
      tailEdits.push({ ...rel(splitBlock.endAtRange), replacement: String(clip.endAt) });
    }
  }
  const tailText = applyEdits(headText, tailEdits);

  // 4. Insert the tail right after the head, matching its indentation.
  const insertAt = splitBlock.blockEnd;
  const newline = patched.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = patched.lastIndexOf("\n", splitBlock.blockStart - 1) + 1;
  const indent = patched.slice(lineStart, splitBlock.blockStart);
  const nextCode =
    patched.slice(0, insertAt) + newline + indent + tailText + patched.slice(insertAt);

  const total = Math.max(
    1,
    ...doc.clips.map((c) =>
      c.id === clipId
        ? Math.max(clip.from + headDuration, tailFrom + tailDuration)
        : c.from + c.durationInFrames,
    ),
  );
  const withTotal = setDurationExport(nextCode, total);

  return docFromCode(withTotal, doc.fps) ?? doc;
}

/**
 * Ripple delete: remove a clip and close the gap. Deleting from the magnetic
 * BASE track slides everything after it left — including the audio and overlays
 * sitting over that footage, so music and captions keep their sync. Deleting a
 * FREE-track clip removes only that clip; the footage underneath must not jump.
 */
export function rippleDeleteClip(doc: EditableDoc, clipId: string): EditableDoc {
  const deleted = doc.clips.find((c) => c.id === clipId);
  if (!deleted || !deleted.sourceRange) return doc;
  const shift = deleted.track === "base" ? deleted.durationInFrames : 0;

  const remaining = doc.clips
    .filter((c) => c.id !== clipId)
    .map((c) =>
      shift > 0 && c.from >= deleted.from
        ? { ...c, from: Math.max(0, c.from - shift) }
        : c,
    );

  const edits: Edit[] = [deleteBlockEdit(doc.originalCode, deleted.sourceRange)];
  edits.push(...collectClipEdits(remaining));
  const out = applyEdits(doc.originalCode, edits, totalOf(remaining));
  return docFromCode(out, doc.fps) ?? doc;
}

/**
 * Splice a whole `<Sequence>` block out, swallowing its own line so no blank
 * line is left behind.
 */
function deleteBlockEdit(src: string, range: { start: number; end: number }): Edit {
  let delStart = range.start;
  let delEnd = range.end;
  const lineStart = src.lastIndexOf("\n", delStart - 1) + 1;
  if (/^\s*$/.test(src.slice(lineStart, delStart))) delStart = lineStart;
  while (delEnd < src.length && (src[delEnd] === " " || src[delEnd] === "\t")) delEnd++;
  if (src[delEnd] === "\r") delEnd++;
  if (src[delEnd] === "\n") delEnd++;
  return { start: delStart, end: delEnd, replacement: "" };
}

/**
 * Ripple-delete several clips at once (multi-select). Each survivor slides left
 * by the total duration of removed BASE-track clips that were before it — the
 * same gap-closing semantics as single ripple, applied atomically. Removed
 * free-track clips leave no gap to close.
 */
export function rippleDeleteClips(doc: EditableDoc, ids: string[]): EditableDoc {
  const idSet = new Set(ids);
  const removed = doc.clips.filter((c) => idSet.has(c.id));
  if (removed.length === 0) return doc;
  const shiftFor = (from: number) =>
    removed
      .filter((r) => r.track === "base" && r.from < from)
      .reduce((sum, r) => sum + r.durationInFrames, 0);

  const kept = doc.clips
    .filter((c) => !idSet.has(c.id))
    .map((c) => ({ ...c, from: Math.max(0, c.from - shiftFor(c.from)) }));

  const edits: Edit[] = [];
  for (const r of removed) {
    if (r.sourceRange) edits.push(deleteBlockEdit(doc.originalCode, r.sourceRange));
  }
  edits.push(...collectClipEdits(kept));
  const out = applyEdits(doc.originalCode, edits, totalOf(kept));
  return docFromCode(out, doc.fps) ?? doc;
}

/**
 * Reorder a clip into a new position — how NLE reordering works. Base track
 * only: free-track clips (audio, overlays) are positioned by dragging, not by
 * re-packing, so reordering one is a no-op.
 */
export function reorderClip(doc: EditableDoc, clipId: string, targetIndex: number): EditableDoc {
  const moving = doc.clips.find((c) => c.id === clipId);
  if (!moving || moving.track !== "base") return doc;

  const base = doc.clips.filter((c) => c.track === "base").sort((a, b) => a.from - b.from);
  const fromIdx = base.findIndex((c) => c.id === clipId);
  if (fromIdx === -1) return doc;
  const gaps = slotGaps(base);
  const startAt = base[0].from;
  const [moved] = base.splice(fromIdx, 1);
  const clamped = Math.max(0, Math.min(base.length, targetIndex));
  base.splice(clamped, 0, moved);

  return relayout(doc, base, gaps, startAt);
}

/**
 * Re-lay the base track in visual order, preserving each slot's spacing. Kept
 * because the timeline calls it after an in-place trim; trims now ripple on
 * their own, so this is a no-op on a consistent doc rather than something that
 * would flatten authored gaps and crossfade overlaps.
 */
export function repack(doc: EditableDoc): EditableDoc {
  const base = doc.clips.filter((c) => c.track === "base").sort((a, b) => a.from - b.from);
  if (base.length === 0) return doc;
  return relayout(doc, base, slotGaps(base), base[0].from);
}

/**
 * The gap that follows each base slot in the current layout. Negative means the
 * next clip overlaps this one — which is how a crossfade is expressed, so it
 * has to survive a re-lay.
 */
function slotGaps(base: EditableClip[]): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < base.length - 1; i++) {
    gaps.push(base[i + 1].from - (base[i].from + base[i].durationInFrames));
  }
  return gaps;
}

/** Lay `ordered` out from `startAt` using `gaps`, carrying the free tracks along. */
function relayout(
  doc: EditableDoc,
  ordered: EditableClip[],
  gaps: number[],
  startAt: number,
): EditableDoc {
  let run = startAt;
  const shifts: { at: number; delta: number }[] = [];
  const relaidBase = ordered.map((c, i) => {
    const nc = { ...c, from: run };
    shifts.push({ at: c.from, delta: run - c.from });
    run += c.durationInFrames + (gaps[i] ?? 0);
    return nc;
  });
  shifts.sort((a, b) => a.at - b.at);

  const relaidFree = doc.clips
    .filter((c) => c.track === "free")
    .map((c) => {
      // Ride along with the last base clip starting at or before this one, so
      // music and captions keep their place over the footage.
      let delta = 0;
      for (const sh of shifts) {
        if (sh.at <= c.from) delta = sh.delta;
        else break;
      }
      return delta === 0 ? c : { ...c, from: Math.max(0, c.from + delta) };
    });

  const clips = [...relaidBase, ...relaidFree];
  return {
    ...doc,
    clips,
    totalDurationInFrames: Math.max(0, ...clips.map((c) => c.from + c.durationInFrames), 0),
  };
}

/**
 * Snap candidates for dragging/trimming: every OTHER clip's edges, the ends of
 * the timeline, and (optionally) the playhead. Callers snap the manipulated edge
 * to the nearest of these within a pixel-derived threshold.
 */
export function getSnapTargets(
  doc: EditableDoc,
  opts: { excludeClipId?: string; playhead?: number } = {},
): number[] {
  const t = new Set<number>([0, doc.totalDurationInFrames]);
  for (const c of doc.clips) {
    if (c.id === opts.excludeClipId) continue;
    t.add(c.from);
    t.add(c.from + c.durationInFrames);
  }
  if (opts.playhead != null) t.add(Math.round(opts.playhead));
  return [...t].sort((a, b) => a - b);
}

export function snapFrame(
  frame: number,
  targets: number[],
  threshold: number,
): { frame: number; snapped: number | null } {
  let best: number | null = null;
  let bestDist = threshold + 1;
  for (const tg of targets) {
    const d = Math.abs(tg - frame);
    if (d <= threshold && d < bestDist) {
      best = tg;
      bestDist = d;
    }
  }
  return best != null ? { frame: best, snapped: best } : { frame, snapped: null };
}
