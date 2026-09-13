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
import fs from "fs";
import path from "path";
import { docFromVideoEdit, suspiciousSegments } from "../lib/editor-import";
import {
  addAsset, addItem, addTrack, docDuration, emptyDoc, findItem, isValidDoc,
  makeId, moveItem, removeItem, reorderTrack, rippleRemoveItem, setLayout,
  captionPageAt, cloneItem, duplicateItem, moveItemToTrack, paginateCaptions,
  resizeLayout, snapBox, splitItem, trimItem, updateItem,
  type Asset, type CaptionToken, type EditorDoc, type SolidItem, type TextItem, type VideoItem,
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

head("canvas: resize handles");
{
  const o = { x: 100, y: 100, width: 200, height: 100 };
  a(JSON.stringify(resizeLayout(o, "e", 50, 0)) === JSON.stringify({ x: 100, y: 100, width: 250, height: 100 }),
    "east grows width, origin fixed");
  a(JSON.stringify(resizeLayout(o, "s", 0, 40)) === JSON.stringify({ x: 100, y: 100, width: 200, height: 140 }),
    "south grows height, origin fixed");
  // The corner cases that go wrong quietly: west/north move the origin too.
  a(JSON.stringify(resizeLayout(o, "w", 50, 0)) === JSON.stringify({ x: 150, y: 100, width: 150, height: 100 }),
    "west moves x AND shrinks width");
  a(JSON.stringify(resizeLayout(o, "n", 0, 30)) === JSON.stringify({ x: 100, y: 130, width: 200, height: 70 }),
    "north moves y AND shrinks height");
  a(JSON.stringify(resizeLayout(o, "nw", 20, 20)) === JSON.stringify({ x: 120, y: 120, width: 180, height: 80 }),
    "corner does both axes");
  // A box may never invert — the moving edge stops at the minimum.
  const crushed = resizeLayout(o, "w", 1000, 0);
  a(crushed.width === 8 && crushed.x === 292, `west crush stops at the fixed edge (got x ${crushed.x}, w ${crushed.width})`);
  const crushedN = resizeLayout(o, "n", 0, 1000);
  a(crushedN.height === 8 && crushedN.y === 192, `north crush stops at the fixed edge (got y ${crushedN.y}, h ${crushedN.height})`);
  a(resizeLayout(o, "e", -1000, 0).width === 8, "east crush clamps too");
}

head("canvas: snapping to the frame");
{
  const size = { width: 1000, height: 500, fps: 30 };
  const near = snapBox(3, 200, 200, 100, size, 8);
  a(near.x === 0 && near.guideX === 0, "left edge snaps to the frame edge");
  const centre = snapBox(398, 200, 200, 100, size, 8);
  a(centre.x === 400 && centre.guideX === 500, `centre snaps to the frame centre (got ${centre.x})`);
  const right = snapBox(795, 200, 200, 100, size, 8);
  a(right.x === 800 && right.guideX === 1000, "right edge snaps to the frame edge");
  // Careful choosing this fixture: a 200-wide box at x=300 has its RIGHT edge on
  // the frame centre, so it snaps — correctly. Use a box whose edges and centre
  // are all far from every guide.
  const none = snapBox(300, 200, 100, 100, size, 8);
  a(none.x === 300 && none.guideX === null, `nothing nearby, nothing moves (got ${none.x})`);
  const vert = snapBox(300, 197, 200, 100, size, 8);
  a(vert.y === 200 && vert.guideY === 250, "vertical centre snaps independently");
}

head("captions: paging");
{
  const say = (words: string[], start = 0, each = 0.3, gapBefore = 0): CaptionToken[] => {
    let t = start + gapBefore;
    return words.map((w) => { const tok = { text: w, startSec: t, endSec: t + each }; t += each; return tok; });
  };

  // Plain run of speech: breaks on the word cap.
  const many = say(["one","two","three","four","five","six","seven","eight"]);
  const pages = paginateCaptions(many, 100000, 3, 10);
  a(pages.length === 3, `8 words at 3 per page = 3 pages (got ${pages.length})`);
  a(pages[0].tokens.map(t => t.text).join(" ") === "one two three", "first page holds the first three");
  a(pages[2].tokens.length === 2, "last page holds the remainder");

  // The duration cap closes a page even mid-phrase.
  const timed = paginateCaptions(many, 700, 99, 10);
  a(timed.length > 1, "a long run is split by the duration cap");
  a(timed.every(p => (p.endSec - p.startSec) * 1000 <= 700 + 1), "no page outruns its duration cap");

  // A real pause should break the page — reads far better than a timer break.
  const sentence = [...say(["hello","there"]), ...say(["new","thought"], 2.5)];
  const broken = paginateCaptions(sentence, 100000, 99, 0.6);
  a(broken.length === 2, `a 1.9s pause starts a new page (got ${broken.length})`);
  a(broken[1].tokens[0].text === "new", "the break lands at the pause");

  // Lookup, including the gaps between pages.
  a(captionPageAt(broken, 0.1)?.tokens[0].text === "hello", "finds the page at a time inside it");
  a(captionPageAt(broken, 2.6)?.tokens[0].text === "new", "finds the later page");
  a(captionPageAt(broken, 1.5) === null, "silence between pages shows nothing");
  a(captionPageAt(broken, 99) === null, "past the end shows nothing");
  a(paginateCaptions([], 1200).length === 0, "no words, no pages");
}

head("importing a real AI interview edit as editable clips");
{
  // Every video project with a topics array should come in as clips rather than
  // one immovable block — that is the difference between "it opens" and "it is
  // useful".
  const ROOT = path.join(__dirname, "..", "data", "projects");
  let checked = 0;
  for (const id of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, id, "project.json");
    if (!fs.existsSync(f)) continue;
    let p: { code?: string; animationType?: string; settings?: { fps?: number } };
    try { p = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (!p.code || p.animationType !== "video") continue;
    const size = { width: 1920, height: 1080, fps: p.settings?.fps ?? 25 };
    const imported = docFromVideoEdit(p.code, size);
    if (!imported) continue;
    checked++;
    const tag = id.slice(0, 8);
    a(isValidDoc(imported), `${tag}: imported document is valid`);
    a(imported.assets.length === 1, `${tag}: one source asset registered`);
    const clips = imported.tracks[0].items;
    a(clips.length >= 2, `${tag}: ${clips.length} footage clips`);
    a(clips.every((c) => "sourceIn" in c && "sourceOut" in c), `${tag}: every clip carries its source range`);
    a(clips.every((c) => "assetId" in c && c.assetId === imported.assets[0].id), `${tag}: clips point at the registered asset`);
    // Laid end to end, so the cut plays straight through with no black.
    let cursor = 0;
    const gapless = clips.every((c) => { const ok = c.from === cursor; cursor += c.durationInFrames; return ok; });
    a(gapless, `${tag}: clips are laid end to end`);
    a(docDuration(imported) === cursor, `${tag}: duration is the sum of the clips`);
  }
  a(checked > 0, `found at least one importable interview edit (checked ${checked})`);
}

head("flagging topics the generator left with no footage");
{
  const code = `const SRC = "/api/media/p/a.mp4";
const SEGMENTS = [
  { eyebrow: "Good", startSec: 10, endSec: 30 },
  { eyebrow: "Broken", startSec: 125.1, endSec: 125.2 },
  { eyebrow: "Also good", startSec: 60, endSec: 90 },
];`;
  const odd = suspiciousSegments(code, 25);
  a(odd.length === 1 && odd[0].label === "Broken", `finds the near-empty topic (got ${JSON.stringify(odd)})`);
  a(suspiciousSegments(code, 25, 0.05).length === 0, "threshold is respected");
  const doc = docFromVideoEdit(code, { width: 1920, height: 1080, fps: 25 });
  a(doc !== null && doc.tracks[0].items.length === 3, "the broken topic still imports — it is the user's to fix, not ours to drop");
}

head("moving a clip between tracks");
{
  let doc = base();
  doc = addTrack(doc, "B");
  const [ta, tb] = doc.tracks.map((t) => t.id);
  doc = addItem(doc, ta, clip("a", 0, 90));
  doc = addItem(doc, ta, clip("b", 90, 90));

  const moved = moveItemToTrack(doc, "b", tb, 200);
  a(moved.tracks[0].items.length === 1, "left the old track");
  a(moved.tracks[1].items.length === 1, "landed on the new one");
  a(findItem(moved, "b")!.item.from === 200, "landed where it was dropped");
  a(isValidDoc(moved), "still valid");

  // Dropping onto an occupied slot slides it clear rather than refusing.
  let busy = addItem(doc, tb, clip("c", 0, 120));
  busy = moveItemToTrack(busy, "b", tb, 0);
  a(findItem(busy, "b")!.item.from === 120, `pushed past the occupant (got ${findItem(busy, "b")!.item.from})`);
  a(isValidDoc(busy), "no overlap after the push");

  // Same track is an ordinary move, still clamped by neighbours.
  const same = moveItemToTrack(doc, "b", ta, 0);
  a(findItem(same, "b")!.item.from === 90, "moving onto its own track is clamped like a normal move");
  a(moveItemToTrack(doc, "b", "nope", 0) === doc, "unknown track is a no-op");
}

head("duplicate and clone");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90, { sourceIn: 5, sourceOut: 8 }));
  const dup = duplicateItem(doc, "a");
  const items = dup.tracks[0].items as VideoItem[];
  a(items.length === 2, "duplicated");
  a(items[1].from === 90, "sits straight after the original");
  a(items[1].id !== items[0].id, "gets a fresh id");
  a(items[1].sourceIn === 5 && items[1].sourceOut === 8, "keeps the source trim");
  a(isValidDoc(dup), "still valid");

  const copy = cloneItem(items[0], 500);
  a(copy.id !== items[0].id && copy.from === 500, "clone takes a new id and position");
  a(duplicateItem(doc, "missing") === doc, "duplicating nothing is a no-op");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) process.exit(1);
