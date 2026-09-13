import { docDuration, type EditorDoc } from "./editor-doc";

/**
 * Wrap an editor document as a Remotion scene module.
 *
 * The render pipeline takes a scene file, so exporting a document means handing
 * it one — but the scene does nothing except mount `EditorComposition`, the very
 * component the preview uses. That is what makes the export match what was on
 * screen, and it means every part of the existing pipeline (codecs, the LUT
 * pass, the alpha transcode, the font blocking in `createEntryFile`) applies to
 * documents with no changes at all.
 *
 * The document is inlined as JSON. `/api/render` rewrites any "/api/media/..."
 * source to an absolute origin before this reaches disk, because the headless
 * bundle is served on its own port.
 */
export function sceneCodeFromDoc(doc: EditorDoc): string {
  return `import React from "react";
import { EditorComposition } from "../EditorComposition";

// Generated at export time from the editor document, which is the source of
// truth. Rendering goes through the same component the preview mounts.
const doc = ${JSON.stringify(doc)} as never;

export const fps = ${doc.size.fps};
export const durationInFrames = ${docDuration(doc)};

export default function Scene() {
  return <EditorComposition doc={doc} />;
}
`;
}
