/**
 * Unit tests for the AI's view of the editor document and the edits it can make
 * (lib/editor-agent.ts, lib/editor-transcript.ts).
 *
 *   npx tsx scripts/test-editor-agent.ts
 *
 * No API key and no network: `applyDocTool` is a pure function, so every tool the
 * model can call is checkable exactly here rather than by watching a chat. What
 * these tests are really guarding is that a WRONG tool call cannot damage a
 * document — a bad id, an impossible range, a field that item type does not
 * have. Each of those must come back as an untouched document plus a message the
 * model can act on.
 */
import {
  addAsset, addItem, addTrack, docDuration, emptyDoc, findItem, isValidDoc,
  type Asset, type EditorDoc, type SolidItem, type TextItem, type VideoItem,
} from "../lib/editor-doc";
import {
  applyDocTool, describeDoc, DOC_TOOLS, type AgentContext,
} from "../lib/editor-agent";
import {
  cutRange, docTranscript, frameToSourceSecond, itemSourceWindow,
  silenceGaps, sourceSecondToFrame, wordsForItem,
} from "../lib/editor-transcript";
import { splitItem } from "../lib/editor-doc";
import type { TranscriptWord } from "../lib/transcribe";
import fs from "fs";
import path from "path";
import { sceneFramesAtFps, sceneMeta } from "../lib/scene-eval";

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
const text = (id: string, from: number, dur: number, body = "Hello"): TextItem => ({
  type: "text", id, from, durationInFrames: dur, layout: { ...box },
  text: body, style: { fontFamily: "Inter, sans-serif", fontSize: 64, color: "#F4F4F5" },
});

const asset: Asset = { id: "asset1", kind: "video", src: "/api/media/p/a.mp4", name: "a.mp4", durationSec: 60 };

function base(): EditorDoc {
  return addAsset(emptyDoc(SIZE), asset);
}
const t0 = (doc: EditorDoc) => doc.tracks[0].id;
const ctx = (extra: Partial<AgentContext> = {}): AgentContext => ({ fps: FPS, ...extra });

/** Apply a tool and assert it succeeded, returning the new document. */
function ok(doc: EditorDoc, name: string, input: unknown, c: AgentContext = ctx()): EditorDoc {
  const out = applyDocTool(doc, name, input, c);
  a(!out.isError, `${name} succeeded (got: ${out.result})`);
  a(isValidDoc(out.doc), `${name} left a valid document`);
  return out.doc;
}
/** Apply a tool expecting refusal; assert the document is untouched. */
function refused(doc: EditorDoc, name: string, input: unknown, why: string, c: AgentContext = ctx()) {
  const out = applyDocTool(doc, name, input, c);
  a(out.isError === true, `${name} refused: ${why}`);
  a(out.doc === doc, `${name} left the document untouched: ${why}`);
  return out.result;
}

// ────────────────────────────────────────────────────────────────────────────

head("the outline the model reads");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("vid", 0, 90));
  doc = addTrack(doc, "Titles");
  doc = addItem(doc, doc.tracks[1].id, text("cap", 30, 60, "Turn any website into data"));
  const out = describeDoc(doc, ctx({ playheadFrame: 45, selectedIds: ["cap"] }));

  a(out.includes("1920x1080 @ 30fps"), "states the canvas and frame rate");
  a(out.includes("[vid]") && out.includes("[cap]"), "lists every item id");
  a(out.includes("0-90f") && out.includes("0.00-3.00s"), "gives spans in frames AND seconds");
  a(out.includes("Playhead: frame 45"), "tells the model where the playhead is");
  a(out.includes("Selected right now: cap"), "tells it what is selected");
  a(out.includes("a.mp4"), "names the footage behind a clip, not its asset id");
  a(out.includes("Turn any website into data"), "quotes the words of a text layer");
  a(out.includes("backmost") && out.includes("frontmost"), "says which track is in front");
  a(out.includes("TRANSCRIPTS: none"), "is explicit when there is nothing to listen to");
}

head("a scene item's code never reaches the model");
{
  // A scene item can hold an entire TSX file. Serialising it would swamp the
  // context window with source the model has no business editing from here.
  const marker = "SECRET_SCENE_SOURCE_MARKER";
  let doc = base();
  doc = addItem(doc, t0(doc), {
    type: "scene", id: "sc", from: 0, durationInFrames: 60, layout: { ...box },
    code: `export default function S(){ return <div>${marker}</div> } // ${"x".repeat(5000)}`,
    snippet: { id: "EndCard", values: {} },
  });
  const out = describeDoc(doc, ctx());
  a(!out.includes(marker), "the code body is not in the outline");
  a(out.length < 2000, `the outline stays small (${out.length} chars)`);
  a(out.includes('snippet "EndCard"'), "but the model still learns what the block is");
}

head("every tool is declared properly");
{
  for (const tool of DOC_TOOLS) {
    a((tool.description ?? "").length > 40, `${tool.name} explains itself`);
    a(tool.input_schema.type === "object", `${tool.name} takes an object`);
  }
  const names = DOC_TOOLS.map((t) => t.name);
  a(new Set(names).size === names.length, "no duplicate tool names");
}

head("absolute frames in, deltas under the hood");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("vid", 40, 60));

  // move_item takes where it should END UP, not how far to travel.
  const moved = ok(doc, "move_item", { itemId: "vid", toFrame: 120 });
  a(findItem(moved, "vid")!.item.from === 120, "moved to the absolute frame asked for");

  // trim_item drags one edge TO a frame; the other edge stays put.
  const trimmed = ok(doc, "trim_item", { itemId: "vid", edge: "right", toFrame: 70 });
  const after = findItem(trimmed, "vid")!.item;
  a(after.from === 40 && after.durationInFrames === 30, "right edge dragged to frame 70");

  const left = ok(doc, "trim_item", { itemId: "vid", edge: "left", toFrame: 60 });
  const l = findItem(left, "vid")!.item as VideoItem;
  a(l.from === 60 && l.from + l.durationInFrames === 100, "left edge dragged, right edge fixed");
  a(Math.abs((l.sourceIn ?? 0) - 20 / FPS) < 1e-9, "the source trim followed the edge");
}

head("a made-up id is refused, never guessed at");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("vid", 0, 60));
  const msg = refused(doc, "move_item", { itemId: "nope", toFrame: 10 }, "unknown item id");
  a(msg.includes("vid"), "and the real ids are handed back so it can correct itself");
  refused(doc, "move_item_to_track", { itemId: "vid", trackId: "ghost" }, "unknown track id");
  refused(doc, "remove_track", { trackId: "ghost" }, "unknown track id");
  refused(doc, "split_item", { itemId: "vid", atFrame: 999 }, "split point outside the item");
  refused(doc, "split_item", { itemId: "vid", atFrame: 0 }, "split exactly on the start edge");
  refused(doc, "cut_range", { fromFrame: 50, toFrame: 50 }, "an empty range");
  refused(doc, "set_layout", { itemId: "vid" }, "no fields to set");
}

head("a field the item type doesn't have is refused, not silently dropped");
{
  let doc = base();
  doc = addItem(doc, t0(doc), solid("sol", 0, 60));
  refused(doc, "update_item", { itemId: "sol", text: "nope" }, "solids have no text");
  refused(doc, "update_item", { itemId: "sol", volume: 0.5 }, "solids have no volume");
  const changed = ok(doc, "update_item", { itemId: "sol", color: "#F86606" });
  a((findItem(changed, "sol")!.item as SolidItem).color === "#F86606", "but its colour does change");
}

head("only the allowed animations can be expressed");
{
  let doc = base();
  doc = addItem(doc, t0(doc), text("t", 0, 60));
  doc = addItem(doc, t0(doc), clip("vid", 60, 60));

  for (const banned of ["blur", "fade", "slide", "wipe", "dissolve", "zoomBlur"]) {
    refused(doc, "set_animation", { itemId: "t", in: { preset: banned } }, `"${banned}" is not a preset`);
  }
  // Per-character reveals decompose text, so they cannot apply to footage.
  refused(doc, "set_animation", { itemId: "vid", in: { preset: "type" } }, "type on a video clip");
  const withAnim = ok(doc, "set_animation", { itemId: "t", in: { preset: "type", durationInFrames: 20 } });
  a(findItem(withAnim, "t")!.item.animateIn?.preset === "type", "but type on text works");
  const dflt = ok(doc, "set_animation", { itemId: "vid", in: { preset: "rise" } });
  a(findItem(dflt, "vid")!.item.animateIn?.durationInFrames === 12, "a missing length falls back to 12, never NaN");
  refused(doc, "set_animation", { itemId: "t" }, "neither an in nor an out was given");
}

head("adding layers lands them where the playhead is");
{
  const doc = base();
  const withText = ok(doc, "add_text", { text: "Hello" }, ctx({ playheadFrame: 90 }));
  const added = withText.tracks.flatMap((t) => t.items).find((i) => i.type === "text")!;
  a(added.from === 90, "text starts at the playhead when no frame is given");
  a(added.durationInFrames === FPS * 2, "and runs two seconds by default");
  a((added as TextItem).style.fontFamily.startsWith("Inter"), "in a licensed face");

  const withSolid = ok(withText, "add_solid", { color: "#F86606", fromFrame: 0, durationInFrames: 30 });
  a(withSolid.tracks.flatMap((t) => t.items).some((i) => i.type === "solid"), "solids can be added too");
}

head("placing footage by filename");
{
  const media = ctx({
    playheadFrame: 0,
    mediaFiles: [{ file: "b-roll.mp4", src: "/api/media/p/b-roll.mp4", kind: "video" as const, durationSec: 10 }],
  });
  const doc = base();
  refused(doc, "add_media", { file: "missing.mp4" }, "a file the project doesn't have", media);
  const placed = ok(doc, "add_media", { file: "b-roll.mp4", fromFrame: 0 }, media);
  const item = placed.tracks.flatMap((t) => t.items).find((i) => i.type === "video")!;
  a(item.durationInFrames === 300, "a whole 10s file becomes 300 frames");
  a(placed.assets.some((x) => x.src === "/api/media/p/b-roll.mp4"), "and the asset is registered");

  // Placing the same file twice must not register it twice.
  const twice = ok(placed, "add_media", { file: "b-roll.mp4", fromFrame: 400 }, media);
  a(twice.assets.filter((x) => x.src === "/api/media/p/b-roll.mp4").length === 1, "the asset is reused, not duplicated");
}

head("overlap can never be committed");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 60));
  doc = addItem(doc, t0(doc), clip("b", 60, 60));
  // Moving b onto a is absorbed by findFreeSlot rather than overlapping.
  const moved = ok(doc, "move_item", { itemId: "b", toFrame: 10 });
  a(isValidDoc(moved), "still valid after a move into an occupied frame");
  const b = findItem(moved, "b")!.item;
  a(b.from + b.durationInFrames <= 60 || b.from >= 60, "b landed clear of a");
}

// ── the ears ───────────────────────────────────────────────────────────────

const WORDS: TranscriptWord[] = [
  { text: "Turn", start: 0.0, end: 0.3 },
  { text: "any", start: 0.3, end: 0.6 },
  { text: "website", start: 0.6, end: 1.1 },
  // a two-second hole
  { text: "into", start: 3.1, end: 3.4 },
  { text: "data", start: 3.4, end: 3.9 },
];

head("source seconds ↔ timeline frames");
{
  const item = clip("v", 60, 120, { sourceIn: 10 });
  a(frameToSourceSecond(item, 60, FPS) === 10, "the item's first frame is its sourceIn");
  a(frameToSourceSecond(item, 90, FPS) === 11, "one second in is one second later in the file");
  a(sourceSecondToFrame(item, 11, FPS) === 90, "and back again");
  const win = itemSourceWindow(item, FPS);
  a(win.start === 10 && win.end === 14, "the window is derived from the frames that render");

  const fast = clip("f", 0, 60, { sourceIn: 0, playbackRate: 2 });
  a(frameToSourceSecond(fast, 30, FPS) === 2, "double speed covers twice the file");
  a(itemSourceWindow(fast, FPS).end === 4, "so its window is twice as long");
  a(sourceSecondToFrame(fast, 2, FPS) === 30, "round-trips at double speed");
}

head("words land on the right frames — and follow a split");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("v", 0, 120, { sourceIn: 0 }));
  const all = docTranscript(doc, { asset1: WORDS }, FPS);
  a(all.length === 5, "all five words are inside a 4s clip");
  a(all[0].fromFrame === 0 && all[2].text === "website", "in spoken order");
  a(all[3].fromFrame === Math.round(3.1 * FPS), '"into" lands at 3.1s');

  // Split at 2s. Each half must claim only its own words, with no bookkeeping.
  const cutDoc = splitItem(doc, "v", 60, FPS);
  const pieces = cutDoc.tracks[0].items;
  a(pieces.length === 2, "the clip became two");
  const first = wordsForItem(pieces[0] as VideoItem, WORDS, FPS).map((w) => w.text);
  const second = wordsForItem(pieces[1] as VideoItem, WORDS, FPS).map((w) => w.text);
  a(first.join(" ") === "Turn any website", "the first half keeps the first three words");
  a(second.join(" ") === "into data", "the second half keeps the last two");
  // And the second half's frames are still absolute timeline frames.
  const s = wordsForItem(pieces[1] as VideoItem, WORDS, FPS);
  a(s[0].fromFrame === Math.round(3.1 * FPS), "the later half still reports absolute timeline frames");
}

head("finding the dead air");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("v", 0, 120, { sourceIn: 0 }));
  const words = docTranscript(doc, { asset1: WORDS }, FPS);
  const gaps = silenceGaps(words, { fps: FPS, minSeconds: 0.6 });
  a(gaps.length === 1, `found exactly the one real pause (got ${gaps.length})`);
  a(gaps[0].after === "website" && gaps[0].before === "into", "and knows what is said either side");
  // The pad keeps the cut off the attack of the next word.
  a(gaps[0].fromFrame > Math.round(1.1 * FPS), "leaves air after the last word");
  a(gaps[0].toFrame < Math.round(3.1 * FPS), "leaves air before the next one");
  a(silenceGaps(words, { fps: FPS, minSeconds: 5 }).length === 0, "a high threshold finds nothing");
}

head("cutting a range closes the hole on EVERY track");
{
  // This is the failure the whole design exists to prevent: rippling only the
  // footage track leaves the music and the titles where they were, and every
  // layer silently drifts out of sync with the words it was cut against.
  let doc = base();
  doc = addItem(doc, t0(doc), clip("footage", 0, 300));
  doc = addTrack(doc, "Music");
  doc = addItem(doc, doc.tracks[1].id, clip("music", 0, 300, { sourceIn: 0 }));
  doc = addTrack(doc, "Titles");
  doc = addItem(doc, doc.tracks[2].id, text("title", 200, 60));

  const cut = cutRange(doc, 60, 120, FPS, {});
  a(isValidDoc(cut), "the result is valid");
  a(docDuration(cut) === 240, `60 frames came out of the whole document (got ${docDuration(cut)})`);

  const titles = cut.tracks[2].items;
  a(titles.length === 1 && titles[0].from === 140, "the title on another track shifted by exactly the cut length");

  const music = cut.tracks[1].items;
  a(music.length === 2, "the music was split at both edges of the cut");
  a(music[0].from === 0 && music[0].durationInFrames === 60, "its head is untouched");
  a(music[1].from === 60, "and its tail closed up against the head");
  // The tail must keep playing the RIGHT part of the file, i.e. skip the cut.
  a(Math.abs(((music[1] as VideoItem).sourceIn ?? 0) - 4) < 1e-9, "the tail skips the 2s that were cut out");
}

head("cutting without a ripple leaves the hole");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("a", 0, 300));
  const cut = cutRange(doc, 60, 120, FPS, { ripple: false });
  a(docDuration(cut) === 300, "the video is still as long");
  a(cut.tracks[0].items.length === 2, "but there are now two clips with a gap between");
  a(cut.tracks[0].items[1].from === 120, "the second starts where the cut ended");
}

head("cutting many ranges at once, back to front");
{
  // Cutting gap-by-gap is what a model naturally does, and it is wrong: the
  // first ripple shifts every frame it measured for the rest. The tool takes
  // them all and orders them itself, so the model cannot get this wrong.
  let doc = base();
  doc = addItem(doc, t0(doc), clip("v", 0, 300));
  const out = applyDocTool(
    doc, "cut_range",
    { ranges: [{ fromFrame: 30, toFrame: 60 }, { fromFrame: 200, toFrame: 260 }] },
    ctx(),
  );
  a(!out.isError, `both ranges cut (got: ${out.result})`);
  a(docDuration(out.doc) === 210, `90 frames came out (got ${docDuration(out.doc)})`);

  // The same two cuts applied in the order given must match doing them by hand
  // back-to-front — that equality IS the guarantee.
  let byHand = cutRange(doc, 200, 260, FPS, {});
  byHand = cutRange(byHand, 30, 60, FPS, {});
  a(
    JSON.stringify(out.doc.tracks.map((t) => t.items.map((i) => [i.from, i.durationInFrames]))) ===
      JSON.stringify(byHand.tracks.map((t) => t.items.map((i) => [i.from, i.durationInFrames]))),
    "identical to cutting the later range first by hand",
  );

  // Order given must not matter.
  const reversed = applyDocTool(
    doc, "cut_range",
    { ranges: [{ fromFrame: 200, toFrame: 260 }, { fromFrame: 30, toFrame: 60 }] },
    ctx(),
  );
  const shape = (d: EditorDoc) =>
    JSON.stringify(d.tracks.map((t) => t.items.map((i) => [i.type, i.from, i.durationInFrames])));
  a(shape(reversed.doc) === shape(out.doc), "the order the ranges are given in makes no difference");

  refused(doc, "cut_range", { ranges: [{ fromFrame: 30, toFrame: 90 }, { fromFrame: 60, toFrame: 120 }] },
    "overlapping ranges would double-count");
  refused(doc, "cut_range", { ranges: [] }, "no ranges at all");
  refused(doc, "cut_range", { ranges: [{ fromFrame: 10 }] }, "a range missing its end");

  // The single-range shorthand still works.
  const one = applyDocTool(doc, "cut_range", { fromFrame: 0, toFrame: 30 }, ctx());
  a(!one.isError && docDuration(one.doc) === 270, "the single-range shorthand still cuts");
}

head("cut_range through the tool layer");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("v", 0, 300));
  const out = applyDocTool(doc, "cut_range", { fromFrame: 30, toFrame: 90 }, ctx());
  a(!out.isError, "the cut applied");
  a(docDuration(out.doc) === 240, "and shortened the video");
  a(out.result.includes("8.00s"), `the model is told the new length (got: ${out.result})`);
  a(out.result.includes("1 range"), "and how many ranges went");

  // A cut wholly past the end is harmless.
  const past = applyDocTool(doc, "cut_range", { fromFrame: 1000, toFrame: 1100 }, ctx());
  a(!past.isError && docDuration(past.doc) === 300, "a cut past the end changes nothing");
}

head("listening tools refuse honestly when there is nothing to hear");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("v", 0, 120));
  refused(doc, "find_gaps", {}, "no transcript loaded");
  refused(doc, "read_transcript", {}, "no transcript loaded");

  const heard = ctx({ transcripts: { asset1: WORDS } });
  const read = applyDocTool(doc, "read_transcript", {}, heard);
  a(!read.isError && read.result.includes("website"), "with a transcript it reads back the words");
  a(read.result.includes("f ("), "each word carries the frames it lands on");

  const gaps = applyDocTool(doc, "find_gaps", {}, heard);
  a(!gaps.isError && gaps.result.includes("pause"), "and the pauses are found");
  a(gaps.result.includes("ALL to cut_range in one call"), "and the model is told to cut them in one batch");
}

head("captions come from the transcript, timed to their own item");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("v", 90, 120, { sourceIn: 0 }));
  const heard = ctx({ transcripts: { asset1: WORDS } });
  refused(doc, "add_captions", { itemId: "v" }, "no transcript is loaded", ctx());
  refused(doc, "add_captions", { itemId: "nope" }, "unknown item id", heard);

  const out = applyDocTool(doc, "add_captions", { itemId: "v" }, heard);
  a(!out.isError, `captions were added (got: ${out.result})`);
  const caps = out.doc.tracks.flatMap((t) => t.items).find((i) => i.type === "captions");
  a(!!caps, "a captions layer exists");
  if (caps && caps.type === "captions") {
    a(caps.from === 90 && caps.durationInFrames === 120, "sitting exactly over the clip");
    a(caps.tokens.length === 5, "with every word");
    // Item-relative, so dragging the layer keeps the words on the speech.
    a(caps.tokens[0].startSec === 0, "the first word is at zero seconds INTO THE LAYER, not the timeline");
    a(Math.abs(caps.tokens[3].startSec - 3.1) < 0.05, '"into" is 3.1s into the layer');
  }
}

head("read-only tools never touch the document");
{
  let doc = base();
  doc = addItem(doc, t0(doc), clip("v", 0, 120));
  const heard = ctx({ transcripts: { asset1: WORDS } });
  for (const name of ["read_transcript", "find_gaps"]) {
    const out = applyDocTool(doc, name, {}, heard);
    a(out.doc === doc, `${name} returns the very same document object`);
  }
}

head("cutting through a branded scene block does not restart it");
{
  // This is why the scene window had to follow a split: cutRange splits at BOTH
  // edges of the cut, so a cut landing inside a branded card used to leave the
  // remainder replaying the card from its beginning.
  let doc = base();
  doc = addItem(doc, t0(doc), {
    type: "scene", id: "card", from: 0, durationInFrames: 120, layout: { ...box },
    code: "// branded card", sourceOffsetFrames: 0,
  } as never);

  const out = applyDocTool(doc, "cut_range", { fromFrame: 40, toFrame: 70 }, ctx());
  a(!out.isError, "the cut applied");
  const pieces = out.doc.tracks[0].items as { id: string; from: number; durationInFrames: number; sourceOffsetFrames?: number }[];
  a(pieces.length === 2, `the card became two blocks (got ${pieces.length})`);
  a(pieces[0].sourceOffsetFrames === 0, "the first still starts at the beginning of the card");
  a(
    pieces[1].sourceOffsetFrames === 70,
    `the second resumes PAST the cut at frame 70, not from 0 (got ${pieces[1].sourceOffsetFrames})`,
  );
  a(pieces[1].from === 40, "and sits flush against the first once the hole closes");
}

head("every branded scene reports its real length, computed ones included");
{
  // A regex over `export const durationInFrames = <digits>` silently misses the
  // three scenes that COMPUTE their length, handing back a 250 fallback — for
  // PromptBox that is 90 vs 250, a 2.8x error and a six-second black tail. And
  // those constants are snippet PARAMETERS, so no static table can be right
  // either: the length has to come from the code after substitution.
  const dir = path.join(process.cwd(), "remotion", "scenes", "branded");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  a(files.length > 20, `found the branded library (${files.length} scenes)`);

  let fellBack = 0;
  for (const f of files) {
    const meta = sceneMeta(fs.readFileSync(path.join(dir, f), "utf-8"));
    if (meta.durationInFrames === 250) fellBack++;
    a(meta.durationInFrames > 0 && meta.fps > 0, `${f} resolves a usable length`);
  }
  a(fellBack === 0, `no scene falls back to 250 (got ${fellBack})`);

  const computed: [string, number][] = [["PromptBox", 90], ["AiChat", 375], ["Years", 275]];
  for (const [name, expected] of computed) {
    const meta = sceneMeta(fs.readFileSync(path.join(dir, `${name}.tsx`), "utf-8"));
    a(meta.durationInFrames === expected, `${name} computes ${expected} (got ${meta.durationInFrames})`);
  }

  // A scene is driven by the DOCUMENT's rate once embedded, so a 25fps scene
  // needs proportionally more frames in a 30fps document or it is cut short.
  a(sceneFramesAtFps({ durationInFrames: 775, fps: 25 }, 30) === 930, "775f at 25fps becomes 930f at 30fps");
  a(sceneFramesAtFps({ durationInFrames: 150, fps: 30 }, 30) === 150, "a matching rate is left alone");
  a(sceneFramesAtFps({ durationInFrames: 100, fps: 30 }, 25) === 83, "and it shortens the other way");
  a(sceneFramesAtFps({ durationInFrames: 60, fps: 0 }, 30) === 60, "a missing rate falls through rather than dividing by zero");
}

head("an unknown tool is an error, not a crash");
{
  const doc = base();
  const out = applyDocTool(doc, "definitely_not_a_tool", {}, ctx());
  a(out.isError === true && out.doc === doc, "refused cleanly");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) process.exit(1);
