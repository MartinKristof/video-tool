/**
 * The editor document — a structured representation of a video as tracks of
 * items, rather than a TSX file.
 *
 * This is the source of truth for projects made in the visual editor. Where the
 * legacy model kept Remotion code and edited it by patching bytes (see
 * lib/editable-timeline.ts), a document is editable by construction: there is no
 * parser to defeat and no composition shape to refuse. `remotion/EditorComposition.tsx`
 * turns a document into a rendered video, and the SAME component backs both the
 * preview player and the export, so what you see is what renders.
 *
 * Everything here is pure: `(doc, ...args) => doc`. No React, no I/O.
 *
 * ── Units ────────────────────────────────────────────────────────────────────
 * Timeline positions (`from`, `durationInFrames`) are COMPOSITION frames.
 * Media trims (`sourceIn`, `sourceOut`) are SECONDS into the source file.
 *
 * Seconds are deliberate. Remotion's `trimBefore`/`trimAfter` are composition
 * frames — they are applied as a `<Sequence from={-trimBefore}>` offset and the
 * media element then seeks to `frame / useVideoConfig().fps`, which never
 * consults the file's own frame rate. Storing seconds and converting at render
 * time means a project's fps can change without silently reinterpreting every
 * trim, and removes a whole class of source-vs-composition frame confusion.
 */

export const EDITOR_DOC_VERSION = 1;

export interface DocSize {
  width: number;
  height: number;
  fps: number;
}

/** Where an item sits on the canvas, in composition pixels. */
export interface ItemLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, about the item's centre. */
  rotation?: number;
  /** 0..1 */
  opacity?: number;
  cornerRadius?: number;
}

export type AssetKind = "video" | "audio" | "image" | "gif";

export interface Asset {
  id: string;
  kind: AssetKind;
  /**
   * Either a project-media URL ("/api/media/<projectId>/<rel>") or a path for
   * `staticFile()` ("assets/logos/foo.png"). Rendered as-is; the render route
   * rewrites project-media URLs to an absolute origin.
   */
  src: string;
  name: string;
  /** Source duration in seconds, from ffprobe. Undefined until probed. */
  durationSec?: number;
  width?: number;
  height?: number;
}

interface ItemBase {
  id: string;
  /** Composition frame this item starts at. */
  from: number;
  durationInFrames: number;
  layout: ItemLayout;
}

/** Fields shared by anything with a soundtrack or a source file to trim. */
interface MediaFields {
  assetId: string;
  /** Seconds into the source where playback starts. */
  sourceIn?: number;
  /** Seconds into the source where playback stops. */
  sourceOut?: number;
  /** 0..1, linear. */
  volume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** 1 = normal. */
  playbackRate?: number;
}

export interface VideoItem extends ItemBase, MediaFields {
  type: "video";
}
export interface AudioItem extends ItemBase, MediaFields {
  type: "audio";
}
export interface ImageItem extends ItemBase {
  type: "image";
  assetId: string;
  /** "cover" crops to fill the layout box, "contain" fits inside it. */
  fit?: "cover" | "contain" | "fill";
}
export interface GifItem extends ItemBase {
  type: "gif";
  assetId: string;
  fit?: "cover" | "contain" | "fill";
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight?: number;
  color: string;
  align?: "left" | "center" | "right";
  lineHeight?: number;
  letterSpacing?: number;
  backgroundColor?: string;
  padding?: number;
  backgroundRadius?: number;
}

export interface TextItem extends ItemBase {
  type: "text";
  text: string;
  style: TextStyle;
}

export interface SolidItem extends ItemBase {
  type: "solid";
  color: string;
}

/**
 * One spoken word, timed in seconds FROM THE START OF ITS ITEM — not from the
 * start of the composition.
 *
 * That choice is deliberate: item-relative times move and trim with the item, so
 * dragging captions along the timeline keeps them in sync with the words. Times
 * anchored to the composition would silently desync the moment anything moved,
 * which is exactly how the full-length audio bed caught us out.
 */
export interface CaptionToken {
  text: string;
  startSec: number;
  endSec: number;
}

export interface CaptionsItem extends ItemBase {
  type: "captions";
  tokens: CaptionToken[];
  style: TextStyle;
  /** Colour of the word currently being spoken. */
  highlightColor?: string;
  /** How long one page of words stays on screen, in milliseconds. */
  pageDurationMs?: number;
  /** Most words shown at once before the page breaks. */
  maxWordsPerPage?: number;
}

/**
 * An AI-generated Remotion scene, placed as an item. This is the bridge between
 * the generator and the editor: the AI keeps writing TSX exactly as it does now,
 * and its output becomes a block you can position, trim and layer. It is also
 * how an existing code-first project enters the editor — wrapped whole, with
 * nothing parsed.
 */
export interface SceneItem extends ItemBase {
  type: "scene";
  code: string;
}

export type EditorItem =
  | VideoItem
  | AudioItem
  | ImageItem
  | GifItem
  | TextItem
  | SolidItem
  | CaptionsItem
  | SceneItem;

export type ItemType = EditorItem["type"];

export interface Track {
  id: string;
  name: string;
  hidden?: boolean;
  muted?: boolean;
  /** Kept sorted by `from`, and non-overlapping. */
  items: EditorItem[];
}

export interface EditorDoc {
  version: number;
  size: DocSize;
  /** Later tracks render in FRONT of earlier ones. */
  tracks: Track[];
  assets: Asset[];
}

// ── construction ────────────────────────────────────────────────────────────

let idCounter = 0;
/** Ids only need to be unique within a document. */
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function emptyDoc(size: DocSize): EditorDoc {
  return {
    version: EDITOR_DOC_VERSION,
    size,
    tracks: [{ id: makeId("track"), name: "Track 1", items: [] }],
    assets: [],
  };
}

/** A layout filling the whole frame — the sensible default for footage. */
export function fullFrameLayout(size: DocSize): ItemLayout {
  return { x: 0, y: 0, width: size.width, height: size.height };
}

// ── reading ─────────────────────────────────────────────────────────────────

export function docDuration(doc: EditorDoc): number {
  let max = 0;
  for (const track of doc.tracks) {
    for (const item of track.items) {
      max = Math.max(max, item.from + item.durationInFrames);
    }
  }
  return Math.max(1, max);
}

export function findItem(
  doc: EditorDoc,
  itemId: string,
): { track: Track; item: EditorItem; index: number } | null {
  for (const track of doc.tracks) {
    const index = track.items.findIndex((i) => i.id === itemId);
    if (index !== -1) return { track, item: track.items[index], index };
  }
  return null;
}

export function getAsset(doc: EditorDoc, assetId: string): Asset | undefined {
  return doc.assets.find((a) => a.id === assetId);
}

/** Items that are on screen at `frame`, front-most last. */
export function itemsAtFrame(doc: EditorDoc, frame: number): EditorItem[] {
  const out: EditorItem[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const item of track.items) {
      if (frame >= item.from && frame < item.from + item.durationInFrames) out.push(item);
    }
  }
  return out;
}

// ── invariants ──────────────────────────────────────────────────────────────

/**
 * Items in a track may not overlap — that is what keeps trim and ripple
 * unambiguous. Layering is what tracks are for. Returns the room an item has to
 * grow into, bounded by its neighbours.
 */
function bounds(track: Track, itemId: string): { min: number; max: number } {
  const sorted = [...track.items].sort((a, b) => a.from - b.from);
  const i = sorted.findIndex((it) => it.id === itemId);
  if (i === -1) return { min: 0, max: Number.POSITIVE_INFINITY };
  const prev = sorted[i - 1];
  const next = sorted[i + 1];
  return {
    min: prev ? prev.from + prev.durationInFrames : 0,
    max: next ? next.from : Number.POSITIVE_INFINITY,
  };
}

function sortItems(track: Track): Track {
  return { ...track, items: [...track.items].sort((a, b) => a.from - b.from) };
}

function withTrack(doc: EditorDoc, trackId: string, fn: (t: Track) => Track): EditorDoc {
  return { ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? sortItems(fn(t)) : t)) };
}

function replaceItem(doc: EditorDoc, itemId: string, fn: (i: EditorItem) => EditorItem): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  return withTrack(doc, found.track.id, (t) => ({
    ...t,
    items: t.items.map((i) => (i.id === itemId ? fn(i) : i)),
  }));
}

/** True when no track has overlapping items. Used by tests and by validation. */
export function isValidDoc(doc: EditorDoc): boolean {
  for (const track of doc.tracks) {
    const sorted = [...track.items].sort((a, b) => a.from - b.from);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].from < 0 || sorted[i].durationInFrames < 1) return false;
      const next = sorted[i + 1];
      if (next && sorted[i].from + sorted[i].durationInFrames > next.from) return false;
    }
  }
  return true;
}

// ── operations ──────────────────────────────────────────────────────────────

export function addTrack(doc: EditorDoc, name?: string): EditorDoc {
  const track: Track = {
    id: makeId("track"),
    name: name ?? `Track ${doc.tracks.length + 1}`,
    items: [],
  };
  return { ...doc, tracks: [...doc.tracks, track] };
}

export function removeTrack(doc: EditorDoc, trackId: string): EditorDoc {
  if (doc.tracks.length <= 1) return doc;
  return { ...doc, tracks: doc.tracks.filter((t) => t.id !== trackId) };
}

/** Move a track in the stacking order. Higher index renders in front. */
export function reorderTrack(doc: EditorDoc, trackId: string, targetIndex: number): EditorDoc {
  const from = doc.tracks.findIndex((t) => t.id === trackId);
  if (from === -1) return doc;
  const tracks = [...doc.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(Math.max(0, Math.min(tracks.length, targetIndex)), 0, moved);
  return { ...doc, tracks };
}

export function addAsset(doc: EditorDoc, asset: Asset): EditorDoc {
  if (doc.assets.some((a) => a.id === asset.id)) return doc;
  return { ...doc, assets: [...doc.assets, asset] };
}

/**
 * Place an item on a track. If it would overlap something, it is pushed to the
 * first free slot at or after its requested position rather than rejected —
 * dropping a clip roughly where you want it should work.
 */
export function addItem(doc: EditorDoc, trackId: string, item: EditorItem): EditorDoc {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) return doc;
  let from = Math.max(0, item.from);
  const sorted = [...track.items].sort((a, b) => a.from - b.from);
  for (const other of sorted) {
    const otherEnd = other.from + other.durationInFrames;
    if (from < otherEnd && from + item.durationInFrames > other.from) from = otherEnd;
  }
  return withTrack(doc, trackId, (t) => ({ ...t, items: [...t.items, { ...item, from }] }));
}

export function removeItem(doc: EditorDoc, itemId: string): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  return withTrack(doc, found.track.id, (t) => ({
    ...t,
    items: t.items.filter((i) => i.id !== itemId),
  }));
}

/** Remove an item and slide everything after it on the SAME track left. */
export function rippleRemoveItem(doc: EditorDoc, itemId: string): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  const shift = found.item.durationInFrames;
  return withTrack(doc, found.track.id, (t) => ({
    ...t,
    items: t.items
      .filter((i) => i.id !== itemId)
      .map((i) => (i.from > found.item.from ? { ...i, from: Math.max(0, i.from - shift) } : i)),
  }));
}

/** Slide an item along its track, clamped to the gap between its neighbours. */
export function moveItem(doc: EditorDoc, itemId: string, deltaFrames: number): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  const { min, max } = bounds(found.track, itemId);
  const want = found.item.from + deltaFrames;
  const from = Math.max(min, Math.min(max - found.item.durationInFrames, Math.max(0, want)));
  return replaceItem(doc, itemId, (i) => ({ ...i, from }));
}

/**
 * Drag one edge. The opposite edge stays put, and for media the source trim
 * moves with it so the same footage keeps playing under the cursor.
 */
export function trimItem(
  doc: EditorDoc,
  itemId: string,
  edge: "left" | "right",
  deltaFrames: number,
  fps: number,
): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  const item = found.item;
  const { min, max } = bounds(found.track, itemId);

  if (edge === "right") {
    const maxDuration = max - item.from;
    const duration = Math.max(1, Math.min(maxDuration, item.durationInFrames + deltaFrames));
    const applied = duration - item.durationInFrames;
    return replaceItem(doc, itemId, (i) =>
      hasSource(i) && i.sourceOut != null
        ? { ...i, durationInFrames: duration, sourceOut: i.sourceOut + applied / fps }
        : { ...i, durationInFrames: duration },
    );
  }

  // Left edge: `from` moves, the right edge is fixed.
  const maxLeft = item.from - min;
  const maxRight = item.durationInFrames - 1;
  const applied = Math.max(-maxLeft, Math.min(maxRight, deltaFrames));
  return replaceItem(doc, itemId, (i) => {
    const next = {
      ...i,
      from: i.from + applied,
      durationInFrames: i.durationInFrames - applied,
    };
    if (!hasSource(i)) return next;
    return { ...next, sourceIn: (i.sourceIn ?? 0) + applied / fps };
  });
}

/** Cut an item in two at an absolute composition frame. */
export function splitItem(doc: EditorDoc, itemId: string, atFrame: number, fps: number): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  const item = found.item;
  const local = atFrame - item.from;
  if (local <= 0 || local >= item.durationInFrames) return doc;

  const head: EditorItem = { ...item, durationInFrames: local };
  const tail: EditorItem = {
    ...item,
    id: makeId(item.type),
    from: item.from + local,
    durationInFrames: item.durationInFrames - local,
  };
  if (hasSource(item)) {
    const cutSec = (item.sourceIn ?? 0) + local / fps;
    if (item.sourceOut != null) (head as VideoItem).sourceOut = cutSec;
    (tail as VideoItem).sourceIn = cutSec;
  }
  return withTrack(doc, found.track.id, (t) => ({
    ...t,
    items: t.items.flatMap((i) => (i.id === itemId ? [head, tail] : [i])),
  }));
}

export function setLayout(doc: EditorDoc, itemId: string, patch: Partial<ItemLayout>): EditorDoc {
  return replaceItem(doc, itemId, (i) => ({ ...i, layout: { ...i.layout, ...patch } }));
}

/** Patch arbitrary fields of one item (text content, colour, volume, …). */
export function updateItem<T extends EditorItem>(
  doc: EditorDoc,
  itemId: string,
  patch: Partial<T>,
): EditorDoc {
  return replaceItem(doc, itemId, (i) => ({ ...i, ...patch }) as EditorItem);
}

/** Does this item play a source file that can be trimmed? */
export function hasSource(item: EditorItem): item is VideoItem | AudioItem {
  return item.type === "video" || item.type === "audio";
}

/**
 * Frames worth snapping to while dragging: every other item's edges, zero, the
 * end of the composition, and optionally the playhead. Pair with `snapFrame`
 * from lib/editable-timeline.ts, which is model-agnostic.
 */
export function snapTargets(
  doc: EditorDoc,
  opts: { excludeItemId?: string; playhead?: number } = {},
): number[] {
  const targets = new Set<number>([0, docDuration(doc)]);
  for (const track of doc.tracks) {
    for (const item of track.items) {
      if (item.id === opts.excludeItemId) continue;
      targets.add(item.from);
      targets.add(item.from + item.durationInFrames);
    }
  }
  if (opts.playhead != null) targets.add(Math.round(opts.playhead));
  return [...targets].sort((a, b) => a - b);
}

/**
 * Wrap an existing code-first project as a single scene item — how a legacy
 * project enters the editor without anything being parsed.
 */
export function docFromScene(
  size: DocSize,
  code: string,
  durationInFrames: number,
  name = "Scene",
): EditorDoc {
  const doc = emptyDoc(size);
  const item: SceneItem = {
    type: "scene",
    id: makeId("scene"),
    from: 0,
    durationInFrames: Math.max(1, durationInFrames),
    layout: fullFrameLayout(size),
    code,
  };
  return {
    ...doc,
    tracks: [{ ...doc.tracks[0], name, items: [item] }],
  };
}

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * Apply a resize-handle drag to a layout box, in composition pixels.
 *
 * The west and north handles move the box's origin as well as its size, which is
 * the part that goes wrong quietly. The box is never allowed to invert: at the
 * minimum size the moving edge stops rather than crossing the fixed one.
 */
export function resizeLayout(
  origin: ItemLayout,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  minSize = 8,
): ItemLayout {
  let { x, y, width, height } = origin;

  if (handle.includes("w")) {
    x = origin.x + dx;
    width = origin.width - dx;
  }
  if (handle.includes("e")) width = origin.width + dx;
  if (handle.includes("n")) {
    y = origin.y + dy;
    height = origin.height - dy;
  }
  if (handle.includes("s")) height = origin.height + dy;

  if (width < minSize) {
    width = minSize;
    if (handle.includes("w")) x = origin.x + origin.width - minSize;
  }
  if (height < minSize) {
    height = minSize;
    if (handle.includes("n")) y = origin.y + origin.height - minSize;
  }

  return { ...origin, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * Snap a moving box to the frame's edges and centre lines. Checks the box's
 * leading edge, trailing edge and centre against each guide, so a box lines up
 * whichever part of it you are aiming with.
 */
export function snapBox(
  x: number,
  y: number,
  width: number,
  height: number,
  size: DocSize,
  tolerance: number,
): { x: number; y: number; guideX: number | null; guideY: number | null } {
  const axis = (pos: number, extent: number, guides: number[]) => {
    for (const offset of [0, extent, extent / 2]) {
      for (const g of guides) {
        if (Math.abs(pos + offset - g) <= tolerance) return { pos: g - offset, guide: g };
      }
    }
    return { pos, guide: null as number | null };
  };
  const gx = axis(x, width, [0, size.width / 2, size.width]);
  const gy = axis(y, height, [0, size.height / 2, size.height]);
  return { x: gx.pos, y: gy.pos, guideX: gx.guide, guideY: gy.guide };
}

/** A group of caption words shown together. */
export interface CaptionPage {
  startSec: number;
  endSec: number;
  tokens: CaptionToken[];
}

/**
 * Group caption words into pages that fit on screen.
 *
 * A page closes when it has run for `pageDurationMs`, when it reaches
 * `maxWords`, or when there is a real pause in the speech — a gap longer than
 * `gapSec` means a new thought, and breaking there reads far better than
 * breaking mid-phrase on a timer.
 *
 * Kept here as a pure function rather than pulled in from @remotion/captions so
 * the behaviour is ours to test and tune; that package's
 * `createTikTokStyleCaptions` is the alternative if this ever needs to do more.
 */
export function paginateCaptions(
  tokens: CaptionToken[],
  pageDurationMs = 1200,
  maxWords = 6,
  gapSec = 0.6,
): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let current: CaptionToken[] = [];
  const flush = () => {
    if (current.length === 0) return;
    pages.push({
      startSec: current[0].startSec,
      endSec: current[current.length - 1].endSec,
      tokens: current,
    });
    current = [];
  };

  for (const token of tokens) {
    if (current.length > 0) {
      const pageStart = current[0].startSec;
      const prevEnd = current[current.length - 1].endSec;
      const tooLong = (token.endSec - pageStart) * 1000 > pageDurationMs;
      const tooMany = current.length >= maxWords;
      const pause = token.startSec - prevEnd > gapSec;
      if (tooLong || tooMany || pause) flush();
    }
    current.push(token);
  }
  flush();
  return pages;
}

/** The page showing at `sec` (item-relative), or null between pages. */
export function captionPageAt(pages: CaptionPage[], sec: number): CaptionPage | null {
  for (const page of pages) {
    if (sec >= page.startSec && sec < page.endSec) return page;
  }
  return null;
}

/**
 * Move an item to another track, landing at `from`. Uses the same placement rule
 * as `addItem`, so dropping a clip roughly where you want it on a busy track
 * slides it to the first free slot rather than refusing the move.
 */
export function moveItemToTrack(
  doc: EditorDoc,
  itemId: string,
  targetTrackId: string,
  from: number,
): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  if (found.track.id === targetTrackId) return moveItem(doc, itemId, from - found.item.from);
  if (!doc.tracks.some((t) => t.id === targetTrackId)) return doc;
  const moved = { ...found.item, from: Math.max(0, from) };
  return addItem(removeItem(doc, itemId), targetTrackId, moved);
}

/** A copy of an item with a fresh id, so it can be pasted without colliding. */
export function cloneItem(item: EditorItem, from?: number): EditorItem {
  return { ...item, id: makeId(item.type), from: from ?? item.from };
}

/** Duplicate an item onto its own track, immediately after itself. */
export function duplicateItem(doc: EditorDoc, itemId: string): EditorDoc {
  const found = findItem(doc, itemId);
  if (!found) return doc;
  const copy = cloneItem(found.item, found.item.from + found.item.durationInFrames);
  return addItem(doc, found.track.id, copy);
}
