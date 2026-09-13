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
import { emptyDoc, addItem, addTrack, docDuration, type EditorDoc, type SceneItem, type SolidItem, type TextItem } from "../lib/editor-doc";

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
