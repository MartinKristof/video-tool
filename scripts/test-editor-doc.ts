/**
 * Unit tests for the editor document model (lib/editor-doc.ts).
 *
 *   npx tsx scripts/test-editor-doc.ts
 *
 * These are the tests the legacy code-first model could never have: the document
 * is pure data, so every edit is checkable exactly, with no parsing and no
 * browser. The invariant that matters most is that a track never ends up with
 * overlapping items — that is what keeps trim and ripple unambiguous.
 */
import {
  addAsset, addItem, addTrack, docDuration, emptyDoc, findItem, isValidDoc,
  makeId, moveItem, removeItem, reorderTrack, rippleRemoveItem, setLayout,
  splitItem, trimItem, updateItem,
  type Asset, type EditorDoc, type SolidItem, type TextItem, type VideoItem,
} from "../lib/editor-doc";

let pass = 0, fail = 0;
const a = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL: " + m); } };
const head = (t: string) => console.log("\n--- " + t + " ---");

const SIZE = { width: 1920, height: 1080, fps: 30 };
const FPS = SIZE.fps;
const box = { x: 0, y: 0, width: 1920, height: 1080 };

const clip = (id: string, from: number, dur: number, extra: Partial<VideoItem> = {}): VideoItem => ({
  type: "video", id, from, durationInFrames: dur, layout: { ...box },
  assetId: "asset1", sourceIn: 0, sourceOut: dur / FPS, ...extra,
});
const solid = (id: string, from: number, dur: number): SolidItem =>
  ({ type: "solid", id, from, durationInFrames: dur, layout: { ...box }, color: "#f00" });

const asset: Asset = { id: "asset1", kind: "video", src: "/api/media/p/a.mp4", name: "a.mp4", durationSec: 60 };

function base(): EditorDoc {
  let doc = emptyDoc(SIZE);
  doc = addAsset(doc, asset);
  return doc;
}
const t0 = (doc: EditorDoc) => doc.tracks[0].id;

head("empty document");
{
  const doc = base();
  a(doc.tracks.length === 1, "starts with one track");
  a(docDuration(doc) === 1, "empty duration is 1, never 0");
  a(isValidDoc(doc), "valid");
}

head("adding items — overlap is pushed aside, not rejected");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  doc = addItem(doc, t0(doc), clip("b", 30, 90)); // asked for 30, overlaps a
  const items = doc.tracks[0].items;
  a(items.length === 2, "both items land");
  a(items[0].from === 0 && items[1].from === 90, `pushed to the first free slot (got ${items[1].from})`);
  a(isValidDoc(doc), "no overlap");
  a(docDuration(doc) === 180, `duration 180 (got ${docDuration(doc)})`);
}

head("move is clamped by neighbours");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  doc = addItem(doc, t0(doc), clip("b", 90, 90));
  doc = moveItem(doc, "b", -1000);
  a(findItem(doc, "b")!.item.from === 90, "can't slide into the clip before it");
  doc = moveItem(doc, "a", -1000);
  a(findItem(doc, "a")!.item.from === 0, "can't go before frame 0");
  doc = moveItem(doc, "b", 60);
  a(findItem(doc, "b")!.item.from === 150, "free to move right");
  a(isValidDoc(doc), "still valid");
}

head("trim right — duration and source out-point move together");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));   // sourceOut 3.0s
  doc = trimItem(doc, "a", "right", -30, FPS);
  const it = findItem(doc, "a")!.item as VideoItem;
  a(it.durationInFrames === 60, `shortened to 60 (got ${it.durationInFrames})`);
  a(Math.abs(it.sourceOut! - 2.0) < 1e-9, `source out-point 2.0s (got ${it.sourceOut})`);
  a(it.from === 0, "left edge stayed put");
}

head("trim left — start moves, right edge fixed, source in-point follows");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  doc = trimItem(doc, "a", "left", 30, FPS);
  const it = findItem(doc, "a")!.item as VideoItem;
  a(it.from === 30 && it.durationInFrames === 60, `30..90 (got ${it.from}..${it.from + it.durationInFrames})`);
  a(Math.abs(it.sourceIn! - 1.0) < 1e-9, `source in-point 1.0s (got ${it.sourceIn})`);
  a(it.from + it.durationInFrames === 90, "right edge unchanged");
}

head("trim is clamped by the neighbour and can't invert the clip");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  doc = addItem(doc, t0(doc), clip("b", 90, 90));
  doc = trimItem(doc, "a", "right", 1000, FPS);
  a(findItem(doc, "a")!.item.durationInFrames === 90, "can't grow through the next clip");
  doc = trimItem(doc, "a", "right", -1000, FPS);
  a(findItem(doc, "a")!.item.durationInFrames === 1, "can't shrink below one frame");
  a(isValidDoc(doc), "still valid");
}

head("split — both halves play the right footage");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90, { sourceIn: 10, sourceOut: 13 }));
  doc = splitItem(doc, "a", 30, FPS);
  const items = doc.tracks[0].items as VideoItem[];
  a(items.length === 2, "two items");
  a(items[0].from === 0 && items[0].durationInFrames === 30, "head 0..30");
  a(items[1].from === 30 && items[1].durationInFrames === 60, "tail 30..90");
  a(Math.abs(items[0].sourceOut! - 11) < 1e-9, `head plays 10s..11s (got ${items[0].sourceOut})`);
  a(Math.abs(items[1].sourceIn! - 11) < 1e-9, `tail resumes at 11s (got ${items[1].sourceIn})`);
  a(Math.abs(items[1].sourceOut! - 13) < 1e-9, "tail keeps the original out-point");
  a(items[0].id !== items[1].id, "halves have distinct ids");
  a(isValidDoc(doc), "no overlap");
  a(docDuration(doc) === 90, "total unchanged by a split");
}
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  a(splitItem(doc, "a", 0, FPS).tracks[0].items.length === 1, "split at the very start is refused");
  a(splitItem(doc, "a", 90, FPS).tracks[0].items.length === 1, "split at the very end is refused");
}

head("delete, and ripple delete");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  doc = addItem(doc, t0(doc), clip("b", 90, 60));
  doc = addItem(doc, t0(doc), clip("c", 150, 30));

  const plain = removeItem(doc, "a");
  a(plain.tracks[0].items.length === 2, "removes the item");
  a(findItem(plain, "b")!.item.from === 90, "plain delete leaves a gap");

  const rippled = rippleRemoveItem(doc, "a");
  a(findItem(rippled, "b")!.item.from === 0, "ripple closes the gap");
  a(findItem(rippled, "c")!.item.from === 60, "everything after slides");
  a(docDuration(rippled) === 90, `total drops by the removed length (got ${docDuration(rippled)})`);
  a(isValidDoc(rippled), "still valid");
}

head("tracks stack, and only the doc's track order decides what's in front");
{
  let doc = base();
  doc = addTrack(doc, "Overlay");
  const [bg, fg] = doc.tracks.map((t) => t.id);
  doc = addItem(doc, bg, clip("a", 0, 90));
  doc = addItem(doc, fg, solid("s", 0, 90));
  a(doc.tracks[1].items[0].id === "s", "overlay is the later track, so it paints in front");
  a(isValidDoc(doc), "items on DIFFERENT tracks may overlap in time");

  doc = reorderTrack(doc, fg, 0);
  a(doc.tracks[0].items[0].id === "s", "reorder moves it behind");
}

head("layout and field patches");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  doc = setLayout(doc, "a", { x: 100, opacity: 0.5 });
  const it = findItem(doc, "a")!.item;
  a(it.layout.x === 100 && it.layout.opacity === 0.5, "layout patched");
  a(it.layout.width === 1920, "untouched layout fields survive");

  const text: TextItem = {
    type: "text", id: "t", from: 0, durationInFrames: 60, layout: { ...box },
    text: "hello", style: { fontFamily: "Inter", fontSize: 80, color: "#fff" },
  };
  doc = addTrack(doc, "Text");
  doc = addItem(doc, doc.tracks[doc.tracks.length - 1].id, text);
  const doc2 = updateItem<TextItem>(doc, "t", { text: "goodbye" });
  a((findItem(doc2, "t")!.item as TextItem).text === "goodbye", "text content patched");
}

head("ids are unique");
{
  const ids = new Set(Array.from({ length: 500 }, () => makeId("x")));
  a(ids.size === 500, `500 distinct ids (got ${ids.size})`);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) process.exit(1);
