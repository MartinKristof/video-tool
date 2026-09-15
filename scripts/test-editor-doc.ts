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
import { docFromCutPlan, docFromVideoEdit, suspiciousSegments } from "../lib/editor-import";
import { planCuts, DEFAULT_THRESHOLDS } from "../lib/cut-plan";
import type { Transcript } from "../lib/transcribe";
import { ANIMATION_PRESETS, animationFrames, presetStyle, presetsFor, visibleCharacters, wordProgress } from "../lib/editor-effects";
import { scrubValue } from "../components/ui/ScrubNumber";
import { timecode } from "../components/EditorPlayerControls";
import { evalSceneCode } from "../remotion/DynamicScene";
import {
  addAsset, addItem, addTrack, docDuration, emptyDoc, findItem, isValidDoc,
  makeId, moveItem, removeItem, reorderTrack, rippleRemoveItem, setLayout,
  captionPageAt, cloneItem, duplicateItem, moveItemToTrack, paginateCaptions,
  hasRoomAt, resizeLayout, snapBox, splitItem, trackWithRoomAt, trimItem, updateItem,
  fitSceneItem, retimeSceneCode, sceneFit,
  type Asset, type CaptionToken, type EditorDoc, type SceneItem, type SolidItem, type TextItem, type VideoItem,
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

head("animation length can never reach the renderer as NaN");
{
  // Math.max(1, undefined) is NaN, and Remotion throws on a NaN spring duration
  // — which takes down the whole preview, not just the animation. Every shape a
  // stored document could hold must come back usable.
  const cases: [unknown, number][] = [
    [undefined, 12], [null, 12], [NaN, 12], [0, 12], [-5, 12],
    ["12" as unknown, 12], [12, 12], [1, 1], [7.6, 8], [500, 500],
  ];
  for (const [raw, expected] of cases) {
    const got = animationFrames(raw === undefined ? undefined : { preset: "rise", durationInFrames: raw as number });
    a(got === expected, `duration ${JSON.stringify(raw)} -> ${expected} (got ${got})`);
    a(Number.isFinite(got) && got > 0, `duration ${JSON.stringify(raw)} is always finite and positive`);
  }
  a(animationFrames(undefined, 30) === 30, "the fallback is respected");
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

head("a new layer lands under the playhead");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 300));

  // The playhead sits over an existing clip, so the only track is busy there.
  a(!hasRoomAt(doc.tracks[0], 100, 60), "the track is busy at the playhead");
  const grown = trackWithRoomAt(doc, 100, 60);
  a(grown.doc.tracks.length === 2, "a track is added rather than shunting the layer to the end");
  a(grown.trackId === grown.doc.tracks[1].id, "and it targets the new track");
  a(hasRoomAt(grown.doc.tracks[1], 100, 60), "which has room at the playhead");

  // With room available, no track is added.
  const roomy = trackWithRoomAt(doc, 400, 60);
  a(roomy.doc.tracks.length === 1, "existing space is used, no new track");
  a(roomy.trackId === doc.tracks[0].id, "on the track that had room");

  // Exact-fit gaps count as room, and touching edges don't overlap.
  let gap = base();
  gap = addItem(gap, t0(gap), clip("x", 0, 50));
  gap = addItem(gap, t0(gap), clip("y", 110, 50));
  a(hasRoomAt(gap.tracks[0], 50, 60), "a gap that fits exactly is room");
  a(!hasRoomAt(gap.tracks[0], 50, 61), "one frame too long is not");
  a(hasRoomAt(gap.tracks[0], 160, 10), "after the last clip is room");
}

head("splitting and trimming a SCENE moves its window, like a media trim");
{
  // A scene is windowed onto an embedded composition by `sourceOffsetFrames` —
  // the same idea as sourceIn on a clip, and it needs the same handling. Copy it
  // to the tail unchanged and the second half REPLAYS the first, which is what a
  // cut through a branded card used to do.
  const scene = (id: string, from: number, dur: number, offset = 0): SceneItem => ({
    type: "scene", id, from, durationInFrames: dur, layout: { ...box },
    code: "// scene", sourceOffsetFrames: offset,
  });

  let doc = base();
  doc = addItem(doc, t0(doc), scene("sc", 0, 60));
  const split = splitItem(doc, "sc", 30, FPS);
  const [head0, tail0] = split.tracks[0].items as SceneItem[];
  a(head0.sourceOffsetFrames === 0, "the head keeps the original offset");
  a(tail0.sourceOffsetFrames === 30, `the tail CONTINUES the scene (got ${tail0.sourceOffsetFrames})`);
  a(tail0.id !== head0.id, "and is a new item");

  // An already-windowed scene accumulates rather than resetting.
  let win = base();
  win = addItem(win, t0(win), scene("w", 0, 60, 100));
  const splitWin = splitItem(win, "w", 20, FPS);
  a((splitWin.tracks[0].items[1] as SceneItem).sourceOffsetFrames === 120, "an already-windowed scene accumulates");

  // Dragging the left edge moves the window too.
  const trimmed = trimItem(doc, "sc", "left", 15, FPS);
  a((trimmed.tracks[0].items[0] as SceneItem).sourceOffsetFrames === 15, "a left-trim advances the window");
  // The right edge only shortens it — nothing to move.
  const right = trimItem(doc, "sc", "right", -15, FPS);
  a((right.tracks[0].items[0] as SceneItem).sourceOffsetFrames === 0, "a right-trim leaves the window alone");
  // And it can never go negative.
  const past = trimItem(doc, "sc", "left", -100, FPS);
  a(((past.tracks[0].items[0] as SceneItem).sourceOffsetFrames ?? 0) >= 0, "the window never goes negative");
}

head("a Smart-trim plan becomes an editable timeline");
{
  // Both sides already speak the same units — a KeepRange is seconds into the
  // source, and a media item stores sourceIn/sourceOut in seconds — so each kept
  // range is simply a clip. What used to arrive as one opaque <Series> of
  // hard-coded trims is now one draggable clip per range.
  const plan = {
    ranges: [{ from: 0, to: 2 }, { from: 5, to: 8 }, { from: 10, to: 10.5 }],
    removed: [], originalDuration: 12, trimmedDuration: 5.5,
    thresholds: DEFAULT_THRESHOLDS,
  };
  const doc = docFromCutPlan(plan, SIZE, "/api/media/p/a.mp4", { name: "a.mp4" })!;
  a(!!doc, "built a document");
  a(isValidDoc(doc), "valid");
  a(doc.tracks.length === 1 && doc.tracks[0].items.length === 3, "one clip per kept range");
  a(doc.assets.length === 1 && doc.assets[0].src === "/api/media/p/a.mp4", "with the source registered once");

  const [c1, c2, c3] = doc.tracks[0].items as VideoItem[];
  // Laid end to end: the removed spans become the frames that simply aren't there.
  a(c1.from === 0 && c1.durationInFrames === 60, "first clip is 2s");
  a(c2.from === 60 && c2.durationInFrames === 90, "second starts where the first ends, 3s long");
  a(c3.from === 150 && c3.durationInFrames === 15, "third continues, 0.5s long");
  a(docDuration(doc) === 165, `total is the trimmed length, not the original (got ${docDuration(doc)})`);

  // And each clip plays the right footage — that is what makes the cut correct.
  a(c1.sourceIn === 0 && c1.sourceOut === 2, "clip 1 plays 0-2s of the source");
  a(c2.sourceIn === 5 && c2.sourceOut === 8, "clip 2 SKIPS the 2-5s the planner removed");
  a(c3.sourceIn === 10 && c3.sourceOut === 10.5, "clip 3 skips 8-10s too");

  a(docFromCutPlan({ ...plan, ranges: [] }, SIZE, "/x.mp4") === null, "an empty plan builds nothing");

  // Through the real planner, from a real transcript with a real silence.
  const transcript: Transcript = {
    text: "one two three",
    words: [
      { text: "one", start: 0.0, end: 0.4 },
      { text: "two", start: 0.4, end: 0.9 },
      // a 3-second hole
      { text: "three", start: 3.9, end: 4.4 },
    ],
    segments: [], durationSeconds: 5, language: "en",
    model: "test", generatedAt: new Date(0).toISOString(),
  };
  const real = planCuts(transcript, DEFAULT_THRESHOLDS);
  const realDoc = docFromCutPlan(real, SIZE, "/api/media/p/a.mp4")!;
  a(realDoc.tracks[0].items.length === real.ranges.length, "a real plan maps range-for-range");
  a(isValidDoc(realDoc), "and is valid");
  a(docDuration(realDoc) < 5 * FPS, "the silence really is gone from the timeline");
}

head("viewer timecode");
{
  a(timecode(0, 25) === "00:00:00:00", "zero");
  a(timecode(24, 25) === "00:00:00:24", "last frame of the first second");
  a(timecode(25, 25) === "00:00:01:00", "rolls over to seconds");
  a(timecode(25 * 60, 25) === "00:01:00:00", "rolls over to minutes");
  a(timecode(25 * 3600, 25) === "01:00:00:00", "rolls over to hours");
  a(timecode(917, 25) === "00:00:36:17", `matches an editor's readout (got ${timecode(917, 25)})`);
  a(timecode(-5, 25) === "00:00:00:00", "never negative");
  a(timecode(30, 0) === "00:00:01:05", "survives a zero fps rather than dividing by it");
}

head("a placed scene retimes; a windowed one keeps its authored timing");
{
  // A snippet authored at 30fps, five seconds long.
  const AUTHORED = [
    'import React from "react";',
    "export const fps = 30;",
    "export const durationInFrames = 150;",
    "export default function Card() { return null; }",
  ].join("\n");

  const out = retimeSceneCode(AUTHORED, 125, 25);
  a(/export const durationInFrames = 125;/.test(out), "declared length restated in document frames");
  a(/export const fps = 25;/.test(out), "and the rate with it");
  a(retimeSceneCode(out, 125, 25) === out, "idempotent — re-reading the meta gives the same length back");
  a(!/150|= 30;/.test(out), "the authored numbers are gone, not merely shadowed");

  a(retimeSceneCode('export const durationInFrames: number = 90;', 40, 25).includes("= 40;"),
    "survives a type annotation on the declaration");
  a(retimeSceneCode("const durationInFrames = 150;", 40, 25) === "const durationInFrames = 150;",
    "a non-exported local of the same name is left alone");

  const placed: SceneItem = {
    type: "scene", id: "s1", from: 0, durationInFrames: 125, layout: { ...box },
    code: AUTHORED, snippet: { id: "Card", values: {} },
  };
  const imported: SceneItem = {
    type: "scene", id: "s2", from: 0, durationInFrames: 125, layout: { ...box },
    code: AUTHORED, sourceOffsetFrames: 300,
  };
  a(sceneFit(placed) === "retime", "snippet provenance implies a whole piece");
  a(sceneFit(imported) === "window", "anything else is a window onto a longer composition");
  a(sceneFit({ ...placed, fit: "window" }) === "window", "an explicit fit wins over the inference");

  a(fitSceneItem(placed, 25).code.includes("= 125;"), "a retiming item is brought into document units");
  a(fitSceneItem(imported, 25).code === AUTHORED, "a window is never rewritten — its timing is the original's");
}

head("resizing a placed scene moves its exit; resizing a window moves the window");
{
  const code = ["export const fps = 25;", "export const durationInFrames = 100;", "export default function C(){return null;}"].join("\n");
  const placed: SceneItem = {
    type: "scene", id: "sc", from: 0, durationInFrames: 100, layout: { ...box },
    code, snippet: { id: "Card", values: {} }, fit: "retime",
  };
  const windowed: SceneItem = { ...placed, id: "wn", snippet: undefined, fit: "window", sourceOffsetFrames: 0 };

  let d = emptyDoc(SIZE);
  const tid = d.tracks[0].id;
  d = addItem(d, tid, placed);
  d = addItem(d, tid, { ...windowed, from: 200 });

  const stretched = trimItem(d, "sc", "right", 50, FPS);
  const sc = findItem(stretched, "sc")!.item as SceneItem;
  a(sc.durationInFrames === 150, "the block is longer");
  a(/durationInFrames = 150;/.test(sc.code), "and the animation now ends where the block ends");

  const shrunk = trimItem(stretched, "sc", "right", -100, FPS);
  const sc2 = findItem(shrunk, "sc")!.item as SceneItem;
  a(/durationInFrames = 50;/.test(sc2.code), "shrinking pulls the exit back in too");

  const fromLeft = trimItem(d, "sc", "left", 20, FPS);
  const sc3 = findItem(fromLeft, "sc")!.item as SceneItem;
  a((sc3.sourceOffsetFrames ?? 0) === 0, "a retiming scene never skips into its own middle");
  a(/durationInFrames = 80;/.test(sc3.code), "it replays in full over the length it now has");

  const win = trimItem(d, "wn", "left", 20, FPS);
  const wn = findItem(win, "wn")!.item as SceneItem;
  a(wn.sourceOffsetFrames === 20, "a window still slides");
  a(/durationInFrames = 100;/.test(wn.code), "and keeps the composition's authored length");
}


console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) process.exit(1);
