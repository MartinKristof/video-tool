/**
 * Render proof for the editor document (remotion/EditorComposition.tsx).
 *
 *   npx tsx scripts/test-editor-render.ts
 *
 * The document model is only worth anything if it actually becomes pixels, so
 * this drives the REAL pipeline — the same bundle + renderStill path the export
 * queue uses — and checks that items appear at the frames they claim to.
 * Bundling is slow (tens of seconds); this is a gate, not a watch-mode test.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";
import { emptyDoc, addItem, addTrack, docDuration, type CaptionsItem, type EditorDoc, type SceneItem, type SolidItem, type TextItem } from "../lib/editor-doc";

let pass = 0, fail = 0;
const a = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL: " + m); } };

const SIZE = { width: 640, height: 360, fps: 30 };
const full = { x: 0, y: 0, width: SIZE.width, height: SIZE.height };

const SCENE_CODE = `import React from "react";
import { AbsoluteFill } from "remotion";
export const fps = 30;
export const durationInFrames = 30;
export default function S() {
  return <AbsoluteFill style={{ backgroundColor: "#00ff00" }} />;
}
`;

// A scene that changes over time, so windowing it can be proved rather than
// assumed: green for its first second, magenta for its second.
const TWO_PART_SCENE = `import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
export const fps = 30;
export const durationInFrames = 60;
export default function S() {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ backgroundColor: frame < 30 ? "#00cc00" : "#cc00cc" }} />;
}
`;

function fixture(): EditorDoc {
  let doc = emptyDoc(SIZE);
  const bg = doc.tracks[0].id;
  // Frames 0-29 red, 30-59 blue, 60-89 an AI-generated green scene.
  doc = addItem(doc, bg, { type: "solid", id: "red", from: 0, durationInFrames: 30, layout: { ...full }, color: "#ff0000" } as SolidItem);
  doc = addItem(doc, bg, { type: "solid", id: "blue", from: 30, durationInFrames: 30, layout: { ...full }, color: "#0000ff" } as SolidItem);
  doc = addItem(doc, bg, { type: "scene", id: "scene", from: 60, durationInFrames: 30, layout: { ...full }, code: SCENE_CODE } as SceneItem);
  // A second track that paints text over the first half only.
  doc = addTrack(doc, "Text");
  const fg = doc.tracks[1].id;
  doc = addItem(doc, fg, {
    type: "text", id: "title", from: 0, durationInFrames: 30, layout: { ...full },
    text: "HELLO", style: { fontFamily: "sans-serif", fontSize: 64, color: "#ffffff", align: "center" },
  } as TextItem);
  // Captions on a third track — word times are item-relative, so frame 66 and
  // frame 84 fall on different words and must therefore render differently.
  doc = addTrack(doc, "Captions");
  const cap = doc.tracks[2].id;
  doc = addItem(doc, cap, {
    type: "captions", id: "caps", from: 60, durationInFrames: 30,
    layout: { x: 0, y: 240, width: SIZE.width, height: 90 },
    tokens: [
      { text: "first", startSec: 0.0, endSec: 0.3 },
      { text: "second", startSec: 0.3, endSec: 0.6 },
      { text: "third", startSec: 0.7, endSec: 1.0 },
    ],
    style: { fontFamily: "sans-serif", fontSize: 40, color: "#ffffff", align: "center" },
    highlightColor: "#ff9900",
    pageDurationMs: 700,
    maxWordsPerPage: 2,
  } as CaptionsItem);
  return doc;
}

async function main() {
  const doc = fixture();
  const duration = docDuration(doc);
  a(duration === 90, `fixture is 90 frames (got ${duration})`);

  const scenesDir = path.join(process.cwd(), "remotion", "scenes");
  fs.mkdirSync(scenesDir, { recursive: true });
  const entryPath = path.join(scenesDir, `_editordoc_test_${Date.now().toString(36)}.tsx`);
  fs.writeFileSync(entryPath, `import React from "react";
import { Composition, registerRoot } from "remotion";
import { EditorComposition } from "../EditorComposition";
const doc = ${JSON.stringify(doc)} as never;
const Root: React.FC = () => (
  <Composition
    id="Scene"
    component={EditorComposition as never}
    durationInFrames={${duration}}
    fps={${SIZE.fps}}
    width={${SIZE.width}}
    height={${SIZE.height}}
    defaultProps={{ doc }}
  />
);
registerRoot(Root);
`, "utf-8");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vt-editordoc-"));
  try {
    console.log("bundling…");
    const serveUrl = await bundle({ entryPoint: entryPath, publicDir: path.join(process.cwd(), "public") });
    const composition = await selectComposition({ serveUrl, id: "Scene" });
    a(composition.durationInFrames === duration, "composition length matches the document");
    a(composition.width === SIZE.width && composition.height === SIZE.height, "composition size matches");

    const shots: Record<string, Buffer> = {};
    for (const [label, frame] of [["red", 10], ["blue", 45], ["scene", 75]] as const) {
      const out = path.join(tmp, `${label}.png`);
      await renderStill({ composition, serveUrl, output: out, frame, imageFormat: "png" });
      shots[label] = fs.readFileSync(out);
      a(shots[label].length > 1000, `${label} frame rendered (${shots[label].length} bytes)`);
    }
    a(!shots.red.equals(shots.blue), "frame 10 and frame 45 differ — items are positioned in time");
    a(!shots.blue.equals(shots.scene), "frame 45 and frame 75 differ — the AI scene item renders");

    // Captions: item-relative timing means frame 66 is inside the first page and
    // frame 84 is inside the second, so the two frames must differ.
    const capShots: Record<string, Buffer> = {};
    for (const [label, frame] of [["capA", 66], ["capB", 84]] as const) {
      const out = path.join(tmp, `${label}.png`);
      await renderStill({ composition, serveUrl, output: out, frame, imageFormat: "png" });
      capShots[label] = fs.readFileSync(out);
    }
    a(!capShots.capA.equals(capShots.capB), "caption pages change as words are spoken");
    a(!capShots.capA.equals(shots.scene), "captions paint over the scene item beneath them");

    // An animated item must actually look different while it is arriving.
    const animDoc = (() => {
      let d = emptyDoc(SIZE);
      d = addItem(d, d.tracks[0].id, {
        type: "solid", id: "anim", from: 0, durationInFrames: 30, layout: { ...full },
        color: "#ffaa00", animateIn: { preset: "rise", durationInFrames: 12 },
      } as SolidItem);
      return d;
    })();
    const animEntry = path.join(scenesDir, `_editordoc_anim_${Date.now().toString(36)}.tsx`);
    fs.writeFileSync(animEntry, `import React from "react";
import { Composition, registerRoot } from "remotion";
import { EditorComposition } from "../EditorComposition";
const doc = ${JSON.stringify(animDoc)} as never;
registerRoot(() => (
  <Composition id="Scene" component={EditorComposition as never} durationInFrames={30}
    fps={${SIZE.fps}} width={${SIZE.width}} height={${SIZE.height}} defaultProps={{ doc }} />
));
`, "utf-8");
    try {
      const serve3 = await bundle({ entryPoint: animEntry, publicDir: path.join(process.cwd(), "public") });
      const comp3 = await selectComposition({ serveUrl: serve3, id: "Scene" });
      const shots3: Record<string, Buffer> = {};
      for (const [label, frame] of [["arriving", 1], ["settled", 25]] as const) {
        const out = path.join(tmp, `anim_${label}.png`);
        await renderStill({ composition: comp3, serveUrl: serve3, output: out, frame, imageFormat: "png" });
        shots3[label] = fs.readFileSync(out);
      }
      a(!shots3.arriving.equals(shots3.settled), "an item with animateIn looks different while arriving");
    } finally {
      try { fs.unlinkSync(animEntry); } catch {}
    }

    // The entrance LENGTH must actually matter. This is the case that shipped
    // broken: the spring's duration came from its config, so the frames field in
    // Properties changed nothing. At frame 6 a 4-frame entrance has settled while
    // a 40-frame one is still moving, so the two must render differently.
    const lengthShot = async (durationInFrames: number, label: string) => {
      let d = emptyDoc(SIZE);
      d = addItem(d, d.tracks[0].id, {
        type: "solid", id: "anim", from: 0, durationInFrames: 60, layout: { ...full },
        color: "#ffaa00", animateIn: { preset: "rise", durationInFrames },
      } as SolidItem);
      const entry = path.join(scenesDir, `_editordoc_len_${label}_${Date.now().toString(36)}.tsx`);
      fs.writeFileSync(entry, `import React from "react";
import { Composition, registerRoot } from "remotion";
import { EditorComposition } from "../EditorComposition";
const doc = ${JSON.stringify(d)} as never;
registerRoot(() => (
  <Composition id="Scene" component={EditorComposition as never} durationInFrames={60}
    fps={${SIZE.fps}} width={${SIZE.width}} height={${SIZE.height}} defaultProps={{ doc }} />
));
`, "utf-8");
      try {
        const serve = await bundle({ entryPoint: entry, publicDir: path.join(process.cwd(), "public") });
        const comp = await selectComposition({ serveUrl: serve, id: "Scene" });
        const out = path.join(tmp, `len_${label}.png`);
        await renderStill({ composition: comp, serveUrl: serve, output: out, frame: 6, imageFormat: "png" });
        return fs.readFileSync(out);
      } finally {
        try { fs.unlinkSync(entry); } catch {}
      }
    };
    const quick = await lengthShot(4, "quick");
    const slow = await lengthShot(40, "slow");
    a(!quick.equals(slow), "the entrance LENGTH changes what frame 6 looks like");

    // Windowed scene items: the mechanism that lets a generated edit be split
    // into blocks while its animated title cards keep rendering as authored.
    const windowDoc = (() => {
      let d = emptyDoc(SIZE);
      const t = d.tracks[0].id;
      d = addItem(d, t, { type: "scene", id: "early", from: 0, durationInFrames: 20, layout: { ...full }, code: TWO_PART_SCENE, sourceOffsetFrames: 0 } as SceneItem);
      d = addItem(d, t, { type: "scene", id: "late", from: 20, durationInFrames: 20, layout: { ...full }, code: TWO_PART_SCENE, sourceOffsetFrames: 40 } as SceneItem);
      return d;
    })();
    const windowEntry = path.join(scenesDir, `_editordoc_window_${Date.now().toString(36)}.tsx`);
    fs.writeFileSync(windowEntry, `import React from "react";
import { Composition, registerRoot } from "remotion";
import { EditorComposition } from "../EditorComposition";
const doc = ${JSON.stringify(windowDoc)} as never;
registerRoot(() => (
  <Composition id="Scene" component={EditorComposition as never} durationInFrames={40}
    fps={${SIZE.fps}} width={${SIZE.width}} height={${SIZE.height}} defaultProps={{ doc }} />
));
`, "utf-8");
    try {
      const serve2 = await bundle({ entryPoint: windowEntry, publicDir: path.join(process.cwd(), "public") });
      const comp2 = await selectComposition({ serveUrl: serve2, id: "Scene" });
      const w: Record<string, Buffer> = {};
      for (const [label, frame] of [["unwindowed", 5], ["windowed", 25]] as const) {
        const out = path.join(tmp, `win_${label}.png`);
        await renderStill({ composition: comp2, serveUrl: serve2, output: out, frame, imageFormat: "png" });
        w[label] = fs.readFileSync(out);
      }
      // Block one shows the scene's own frame 5 (green); block two is offset 40
      // frames in, so it shows magenta at the same point in its own timeline.
      a(!w.unwindowed.equals(w.windowed), "a windowed scene item shows a DIFFERENT part of the same composition");
    } finally {
      try { fs.unlinkSync(windowEntry); } catch {}
    }

    // The same frame must render identically twice: the render is deterministic,
    // which is what makes preview-vs-export parity meaningful.
    const again = path.join(tmp, "red2.png");
    await renderStill({ composition, serveUrl, output: again, frame: 10, imageFormat: "png" });
    a(fs.readFileSync(again).equals(shots.red), "re-rendering the same frame is byte-identical");
  } finally {
    try { fs.unlinkSync(entryPath); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
