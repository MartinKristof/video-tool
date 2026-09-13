import { parseSegments } from "./data-timeline";
import {
  emptyDoc, fullFrameLayout, makeId,
  type Asset, type DocSize, type EditorDoc, type EditorItem,
} from "./editor-doc";

/**
 * Recover an AI interview/tutorial edit into editable items.
 *
 * These edits are driven by an array of topics — each with the footage range it
 * plays and the words on its title card — and that array is structured data, not
 * something that has to be parsed out of JSX. So instead of dropping the whole
 * composition in as one immovable block, we can rebuild the AI's DECISIONS as
 * real clips: one footage item per topic, trimmed to the range the AI chose,
 * with its title over the top.
 *
 * This is a recovery, not a reproduction. The branded card design, transitions
 * and audio fades from the generated composition are not recreated — you get the
 * cut, in a form you can actually change. Use `docFromScene` when faithfulness
 * matters more than editability.
 */
export function docFromVideoEdit(
  code: string,
  size: DocSize,
  opts: { titleSeconds?: number; sourceDurationSec?: number } = {},
): EditorDoc | null {
  const segments = parseSegments(code, size.fps);
  if (!segments || segments.segments.length === 0) return null;

  // These edits play from one source file; take the first media reference.
  const srcMatch = /["'`](\/api\/media\/[^"'`]+)["'`]/.exec(code);
  if (!srcMatch) return null;
  const src = srcMatch[1];

  const asset: Asset = {
    id: makeId("asset"),
    kind: "video",
    src,
    name: src.split("/").pop() ?? "footage",
    // Needed for the timeline to window a filmstrip onto the part of the source a
    // clip is trimmed to; without it clips show no thumbnails.
    durationSec: opts.sourceDurationSec,
  };

  const titleFrames = Math.round((opts.titleSeconds ?? 2) * size.fps);
  const footage: EditorItem[] = [];
  const titles: EditorItem[] = [];
  let cursor = 0;

  for (const seg of segments.segments) {
    const seconds = Math.max(0, seg.endSec - seg.startSec);
    const frames = Math.max(1, Math.round(seconds * size.fps));
    footage.push({
      type: "video",
      id: makeId("video"),
      from: cursor,
      durationInFrames: frames,
      layout: fullFrameLayout(size),
      assetId: asset.id,
      sourceIn: seg.startSec,
      sourceOut: seg.endSec,
    });
    if (seg.label) {
      const height = Math.round(size.height * 0.16);
      titles.push({
        type: "text",
        id: makeId("text"),
        from: cursor,
        durationInFrames: Math.min(frames, titleFrames),
        layout: {
          x: Math.round(size.width * 0.07),
          y: Math.round(size.height - height - size.height * 0.1),
          width: Math.round(size.width * 0.86),
          height,
        },
        text: seg.label,
        style: {
          fontFamily: "Inter, sans-serif",
          fontSize: Math.round(size.height * 0.052),
          fontWeight: 700,
          color: "#F4F4F5",
          align: "left",
        },
      });
    }
    cursor += frames;
  }

  const base = emptyDoc(size);
  return {
    ...base,
    assets: [asset],
    tracks: [
      { id: makeId("track"), name: "Footage", items: footage },
      { id: makeId("track"), name: "Titles", items: titles },
    ],
  };
}

/**
 * Topics whose footage range is implausibly short. The generator occasionally
 * writes a range like 125.1 → 125.2, which renders as a few frames — invisible
 * in the finished video and easy to miss until you see the clips laid out.
 */
export function suspiciousSegments(
  code: string,
  fps: number,
  minSeconds = 1,
): { label: string; seconds: number }[] {
  const segments = parseSegments(code, fps);
  if (!segments) return [];
  return segments.segments
    .map((s) => ({ label: s.label, seconds: s.endSec - s.startSec }))
    .filter((s) => s.seconds < minSeconds);
}
