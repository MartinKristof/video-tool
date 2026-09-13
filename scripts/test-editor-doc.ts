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
import { ANIMATION_PRESETS, presetStyle, presetsFor, visibleCharacters, wordProgress } from "../lib/editor-effects";
import { scrubValue } from "../components/ui/ScrubNumber";
import { evalSceneCode } from "../remotion/DynamicScene";
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

head("moving never gets stuck behind a neighbour");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 90));
  doc = addItem(doc, t0(doc), clip("b", 90, 90));

  // With the track full from frame 0 there is genuinely nowhere earlier to go,
  // so the clip stays put rather than overlapping.
  const left = moveItem(doc, "b", -1000);
  a(findItem(left, "b")!.item.from === 90, "nowhere to fit earlier, so it holds position");
  a(isValidDoc(left), "no overlap");

  // Given real room before it, the same drag lands there.
  let roomy = base();
  roomy = addItem(roomy, t0(roomy), clip("x", 300, 90));
  roomy = addItem(roomy, t0(roomy), clip("y", 390, 90));
  const pulled = moveItem(roomy, "y", -1000);
  a(findItem(pulled, "y")!.item.from === 0, `drags past its neighbour into free space (got ${findItem(pulled, "y")!.item.from})`);
  a(isValidDoc(pulled), "no overlap after passing");

  a(findItem(moveItem(doc, "a", -1000), "a")!.item.from === 0, "can't go before frame 0");
  a(findItem(moveItem(doc, "b", 60), "b")!.item.from === 150, "free space is used directly");

  // The reported bug: a clip wedged between two others with no gap either side.
  // It must still be draggable — to the nearest place it fits.
  let wedged = base();
  wedged = addItem(wedged, t0(wedged), clip("before", 0, 50));
  wedged = addItem(wedged, t0(wedged), clip("stuck", 90, 150));
  wedged = addItem(wedged, t0(wedged), clip("after", 240, 100));
  // It lands where it was dragged — past `after`, which is free ground.
  const nudged = moveItem(wedged, "stuck", 400);
  a(findItem(nudged, "stuck")!.item.from === 490,
    `a wedged clip drags out to open ground (got ${findItem(nudged, "stuck")!.item.from})`);
  a(isValidDoc(nudged), "still no overlap");

  // Dragging it a little — not past anything — snaps it to the nearest fit in
  // its own gap rather than refusing to move.
  const small = moveItem(wedged, "stuck", 30);
  a(findItem(small, "stuck")!.item.from === 90 && isValidDoc(small),
    `a short drag with no room stays put rather than overlapping (got ${findItem(small, "stuck")!.item.from})`);
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

head("importing a real AI interview edit, keeping its cards");
{
  // Every video project with a recoverable structure should come in as blocks —
  // footage you can recut, and cards still rendering as they were authored.
  const ROOT = path.join(__dirname, "..", "data", "projects");
  let checked = 0;
  for (const id of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, id, "project.json");
    if (!fs.existsSync(f)) continue;
    let p: { code?: string; animationType?: string; settings?: { fps?: number } };
    try { p = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (!p.code || p.animationType !== "video") continue;
    const evaluated = evalSceneCode(p.code);
    if (!evaluated) continue;
    const size = { width: 1920, height: 1080, fps: evaluated.fps };
    const imported = docFromVideoEdit(p.code, size, {
      compositionDurationInFrames: evaluated.durationInFrames,
    });
    if (!imported) continue;
    checked++;
    const tag = id.slice(0, 8);
    const blocks = imported.tracks[0].items;
    a(isValidDoc(imported), `${tag}: imported document is valid`);
    a(imported.assets.length === 1, `${tag}: one source asset registered`);
    a(blocks.length >= 2, `${tag}: ${blocks.length} blocks`);

    // The whole point: the import must play like the original, to the frame.
    a(docDuration(imported) === evaluated.durationInFrames,
      `${tag}: length matches the original exactly (${docDuration(imported)} vs ${evaluated.durationInFrames})`);

    const footage = blocks.filter((b) => b.type === "video");
    const cards = blocks.filter((b) => b.type === "scene");
    a(footage.length >= 1, `${tag}: has footage clips you can recut`);
    a(cards.length >= 1, `${tag}: has cards preserved as windows on the original`);
    a(footage.every((c) => "sourceIn" in c && "sourceOut" in c), `${tag}: every clip carries its source range`);
    a(footage.every((c) => "assetId" in c && c.assetId === imported.assets[0].id), `${tag}: clips point at the registered asset`);
    // Each card must be windowed onto the frame it actually occupies, or it
    // would render the wrong moment of its animation.
    a(cards.every((c) => c.type === "scene" && c.sourceOffsetFrames === c.from),
      `${tag}: cards are windowed at their own position`);

    let cursor = 0;
    const gapless = blocks.every((b) => { const ok = b.from === cursor; cursor += b.durationInFrames; return ok; });
    a(gapless, `${tag}: blocks are laid end to end`);
  }
  a(checked >= 3, `found the interview edits (checked ${checked})`);
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
  const footage = doc?.tracks[0].items.filter((i) => i.type === "video") ?? [];
  a(footage.length === 3, "the broken topic still imports — it is the user's to fix, not ours to drop");
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

head("animation presets — the bans, asserted in code");
{
  // These keep regressing in generated output, so they are tested rather than
  // trusted. A new preset that breaks one of them fails here.
  for (const preset of ANIMATION_PRESETS) {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      for (const dir of ["in", "out"] as const) {
        const st = presetStyle(preset.id, p, dir);
        a(!/blur/i.test(st.transform), `${preset.id} never blurs (${dir} @ ${p})`);
        a(st.opacity >= 0 && st.opacity <= 1, `${preset.id} opacity stays in range`);
        a(!/(translate[XY]\(-?\d{3,})/.test(st.transform), `${preset.id} travel stays sane (${dir} @ ${p})`);
      }
    }
  }

  // Rule 4: never opacity alone — a moving preset must also transform.
  for (const preset of ANIMATION_PRESETS.filter((x) => !["none", "type", "words"].includes(x.id))) {
    const mid = presetStyle(preset.id, 0.5);
    a(mid.transform !== "none" && mid.transform.length > 0,
      `${preset.id} combines opacity with a transform, never opacity alone`);
    a(mid.opacity > 0 && mid.opacity < 1, `${preset.id} is mid-animation at 0.5`);
  }

  // Settled state must be visually neutral, or a clip would sit wrong forever.
  for (const preset of ANIMATION_PRESETS) {
    const done = presetStyle(preset.id, 1);
    a(done.opacity === 1, `${preset.id} ends fully opaque`);
    a(!/translateX\(-?[1-9]/.test(done.transform) && !/translateY\(-?[1-9]/.test(done.transform),
      `${preset.id} ends with no leftover offset`);
  }

  a(presetStyle("rise", 0).opacity === 0, "rise starts invisible");
  a(presetStyle("none", 0).transform === "none", "cut never transforms");
  // Progress is clamped, so a spring overshooting past 1 can't invert anything.
  a(presetStyle("rise", 2).opacity === 1 && presetStyle("rise", -1).opacity === 0, "progress is clamped");

  // Exit mirrors the entrance direction.
  a(presetStyle("rise", 0, "in").transform !== presetStyle("rise", 0, "out").transform,
    "an exit travels the opposite way to an entrance");
}

head("text decomposition: typing and word cascade");
{
  a(visibleCharacters("hello", 0) === 0, "nothing typed at the start");
  a(visibleCharacters("hello", 1) === 5, "all typed at the end");
  a(visibleCharacters("hello", 0.5) === 3, `half typed is 3 of 5 (got ${visibleCharacters("hello", 0.5)})`);
  a(visibleCharacters("hello", 5) === 5, "clamped past the end");

  a(wordProgress(0, 3, 0) === 0 && wordProgress(2, 3, 1) === 1, "first word starts, last word finishes");
  a(wordProgress(0, 3, 0.3) > wordProgress(2, 3, 0.3), "earlier words lead later ones");
  a(wordProgress(0, 1, 0.5) === 0.5, "a single word just follows the progress");

  // Typing only makes sense on text, so it must not be offered elsewhere.
  const forVideo = presetsFor("video").map((p) => p.id);
  a(!forVideo.includes("type") && !forVideo.includes("words"), "typing is not offered for a video clip");
  a(presetsFor("text").map((p) => p.id).includes("type"), "typing IS offered for text");
}

head("scrubbable number maths");
{
  a(scrubValue(10, 20, 1) === 30, "drag right adds");
  a(scrubValue(10, -20, 1) === -10, "drag left subtracts");
  a(scrubValue(10, 20, 0.5) === 20, "step scales the movement");
  a(scrubValue(10, 20, 1, { shift: true }) === 12, "shift makes it fine");
  a(scrubValue(10, 20, 1, { alt: true }) === 210, "alt makes it coarse");
  a(scrubValue(10, -100, 1, {}, { min: 0 }) === 0, "clamped at the minimum");
  a(scrubValue(10, 100, 1, {}, { max: 50 }) === 50, "clamped at the maximum");
  a(scrubValue(10, 0, 1) === 10, "no movement, no change");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) process.exit(1);
