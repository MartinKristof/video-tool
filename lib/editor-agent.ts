/**
 * The editor document, as seen and edited by the AI.
 *
 * The project already has an agentic loop for CODE (app/api/generate): the model
 * writes a scene, renders frames, looks at them and fixes itself. This is the
 * same idea for the visual editor — except the model does not write anything.
 * It calls tools, and every tool is a one-line call onto a pure function that
 * already exists in lib/editor-doc.ts and has been under test since the document
 * model shipped. Nothing here re-implements an edit.
 *
 * Everything in this file is pure. It can be — and is — tested end to end with
 * no API key and no network (scripts/test-editor-agent.ts).
 *
 * ── Two rules that keep a model from corrupting a document ───────────────────
 *
 * 1. The model never invents an id. Every id it passes must have appeared in
 *    `describeDoc`; new items are minted here with `makeId`. An id it made up is
 *    a tool error handed back for it to correct, not a silent no-op and never a
 *    write.
 *
 * 2. Tools speak in ABSOLUTE frames. `moveItem` and `trimItem` take deltas,
 *    which is right for a mouse but wrong for a model — "put the title at frame
 *    120" is something it can get right from the outline it just read, whereas
 *    "move it by +37" requires it to do the arithmetic first and get that right
 *    too. The conversion happens here, once.
 *
 * A third rule falls out of the type system: `set_animation` takes an ENUM of
 * the seven presets in lib/editor-effects.ts, so the brand's motion bans (no
 * blur on an entrance, no fade from or to black, no slide-wipe, never opacity
 * alone) are not instructions the model has to remember — they are moves it
 * cannot express.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  addAsset,
  addItem,
  addTrack,
  docDuration,
  duplicateItem,
  findItem,
  fullFrameLayout,
  getAsset,
  hasSource,
  isValidDoc,
  makeId,
  moveItem,
  moveItemToTrack,
  removeItem,
  removeTrack,
  rippleRemoveItem,
  setLayout,
  splitItem,
  trackWithRoomAt,
  trimItem,
  updateItem,
  type Asset,
  type AssetKind,
  type CaptionsItem,
  type CaptionToken,
  type EditorDoc,
  type EditorItem,
  type SceneItem,
  type SolidItem,
  type TextItem,
  type TextStyle,
  type VideoItem,
  retimeSceneCode,
} from "./editor-doc";
import { ANIMATION_PRESETS, presetsFor, type AnimationPreset } from "./editor-effects";
import {
  allItems,
  cutRange,
  docTranscript,
  itemSourceWindow,
  silenceGaps,
  wordsInRange,
} from "./editor-transcript";
import type { TranscriptWord } from "./transcribe";
import { describeParams, settableKeys, type SnippetEntry } from "./snippet-catalog";
import { renderSnippet } from "./snippet-template";
import { sceneFramesAtFps } from "./scene-eval";

/** Everything a tool may need that does not live in the document. */
export interface AgentContext {
  fps: number;
  /** Footage the project can place, by filename. */
  mediaFiles?: {
    file: string;
    src: string;
    kind: AssetKind;
    durationSec?: number;
    width?: number;
    height?: number;
  }[];
  /** Word-level transcripts keyed by ASSET id — what is audible on the timeline. */
  transcripts?: Record<string, TranscriptWord[]>;
  /**
   * Word-level transcripts keyed by FILENAME — what is in the footage, whether or
   * not it has been placed yet. Assembling a cut means choosing passages BEFORE
   * anything is on the timeline, and the asset-keyed map above is empty then.
   */
  mediaTranscripts?: Record<string, TranscriptWord[]>;
  /**
   * The branded scene library. Assembled by the route, not read from disk here —
   * this module's contract is that it is pure, which is what lets every failure
   * mode be tested offline.
   */
  snippets?: SnippetEntry[];
  playheadFrame?: number;
  selectedIds?: string[];
}

export interface ToolOutcome {
  doc: EditorDoc;
  result: string;
  isError?: boolean;
}

// ── reading the document ────────────────────────────────────────────────────

function secs(frames: number, fps: number): string {
  return (frames / fps).toFixed(2);
}

function span(from: number, duration: number, fps: number): string {
  const to = from + duration;
  return `${from}-${to}f (${secs(from, fps)}-${secs(to, fps)}s)`;
}

function short(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function animBit(item: EditorItem): string {
  const bits: string[] = [];
  if (item.animateIn && item.animateIn.preset !== "none") {
    bits.push(`in:${item.animateIn.preset}/${item.animateIn.durationInFrames}f`);
  }
  if (item.animateOut && item.animateOut.preset !== "none") {
    bits.push(`out:${item.animateOut.preset}/${item.animateOut.durationInFrames}f`);
  }
  return bits.length ? ` · ${bits.join(" ")}` : "";
}

function describeItem(doc: EditorDoc, item: EditorItem, fps: number): string {
  const head = `  [${item.id}] ${item.type} ${span(item.from, item.durationInFrames, fps)}`;
  const bits: string[] = [];

  switch (item.type) {
    case "video":
    case "audio": {
      const asset = getAsset(doc, item.assetId);
      const win = itemSourceWindow(item, fps);
      bits.push(`"${asset?.name ?? item.assetId}"`);
      bits.push(`source ${win.start.toFixed(2)}-${win.end.toFixed(2)}s`);
      if (item.volume != null && item.volume !== 1) bits.push(`vol ${Math.round(item.volume * 100)}%`);
      if (item.playbackRate && item.playbackRate !== 1) bits.push(`speed ${item.playbackRate}x`);
      if (item.fadeInFrames) bits.push(`fadeIn ${item.fadeInFrames}f`);
      if (item.fadeOutFrames) bits.push(`fadeOut ${item.fadeOutFrames}f`);
      break;
    }
    case "image":
    case "gif": {
      const asset = getAsset(doc, item.assetId);
      bits.push(`"${asset?.name ?? item.assetId}"`);
      if (item.fit) bits.push(item.fit);
      break;
    }
    case "text":
      bits.push(`"${short(item.text)}"`);
      bits.push(`${item.style.fontFamily.split(",")[0]} ${item.style.fontSize}px ${item.style.color}`);
      if (item.style.align) bits.push(item.style.align);
      break;
    case "solid":
      bits.push(item.color);
      break;
    case "captions": {
      const words = item.tokens.length;
      bits.push(`${words} words`);
      bits.push(`"${short(item.tokens.slice(0, 8).map((t) => t.text).join(" "), 50)}"`);
      break;
    }
    case "scene":
      // NEVER the code body — a scene item can hold an entire TSX file, and a
      // document with several of them would swamp the context window with source
      // the model has no business editing from here.
      bits.push(item.snippet ? `snippet "${item.snippet.id}"` : "generated scene");
      if (item.sourceOffsetFrames) bits.push(`window from frame ${item.sourceOffsetFrames}`);
      break;
  }

  const layout = item.layout;
  bits.push(`box ${Math.round(layout.x)},${Math.round(layout.y)} ${Math.round(layout.width)}x${Math.round(layout.height)}`);
  if (layout.rotation) bits.push(`rot ${layout.rotation}°`);
  if (layout.opacity != null && layout.opacity !== 1) bits.push(`opacity ${layout.opacity}`);

  return `${head} · ${bits.join(" · ")}${animBit(item)}`;
}

/**
 * The document as text for the model to read.
 *
 * Deliberately NOT JSON. A `scene` item carries a whole TSX file, so serialising
 * the document would blow the context window on source the model is not editing;
 * and a flat outline is far easier for it to quote ids out of accurately. Every
 * span is given in both frames and seconds because the user talks in seconds and
 * every tool takes frames.
 */
export function describeDoc(doc: EditorDoc, ctx: AgentContext): string {
  const fps = doc.size.fps || ctx.fps;
  const total = docDuration(doc);
  const lines: string[] = [];

  lines.push(
    `DOCUMENT — ${doc.size.width}x${doc.size.height} @ ${fps}fps · ${span(0, total, fps).split(" ")[1]} long (${total} frames) · ${doc.tracks.length} track(s)`,
  );
  if (ctx.playheadFrame != null) {
    lines.push(`Playhead: frame ${ctx.playheadFrame} (${secs(ctx.playheadFrame, fps)}s)`);
  }
  if (ctx.selectedIds?.length) {
    lines.push(`Selected right now: ${ctx.selectedIds.join(", ")}`);
  }
  lines.push("");

  doc.tracks.forEach((track, i) => {
    const where =
      doc.tracks.length === 1
        ? ""
        : i === 0
          ? " (backmost)"
          : i === doc.tracks.length - 1
            ? " (frontmost)"
            : "";
    const flags = [track.hidden ? "HIDDEN" : "", track.muted ? "MUTED" : ""].filter(Boolean);
    // The end frame matters: without it the model has no way to express "after
    // what's already there", and every clip it adds lands on the playhead.
    const end = track.items.reduce((m, i) => Math.max(m, i.from + i.durationInFrames), 0);
    const endsAt = track.items.length ? ` — ends at frame ${end} (${secs(end, fps)}s)` : "";
    lines.push(
      `Track [${track.id}] "${track.name}"${where}${flags.length ? ` [${flags.join(" ")}]` : ""}${endsAt}`,
    );
    if (!track.items.length) lines.push("  (empty)");
    for (const item of [...track.items].sort((a, b) => a.from - b.from)) {
      lines.push(describeItem(doc, item, fps));
    }
  });

  if (ctx.mediaFiles?.length) {
    lines.push("");
    lines.push("FOOTAGE AVAILABLE TO PLACE (use the filename with add_media):");
    for (const m of ctx.mediaFiles) {
      lines.push(`  ${m.file} — ${m.kind}${m.durationSec ? `, ${m.durationSec.toFixed(2)}s` : ""}`);
    }
  }

  const transcribable = allItems(doc).filter(
    ({ item }) => hasSource(item) && ctx.transcripts?.[item.assetId]?.length,
  );
  lines.push("");
  lines.push(
    transcribable.length
      ? `TRANSCRIPTS available for ${transcribable.length} clip(s) — call read_transcript or find_gaps to hear what is said and where.`
      : "TRANSCRIPTS: none available for this document.",
  );

  return lines.join("\n");
}

// ── the tools ───────────────────────────────────────────────────────────────

const PRESET_IDS = ANIMATION_PRESETS.map((p) => p.id);

const ANIM_SPEC = {
  type: "object" as const,
  properties: {
    preset: { type: "string" as const, enum: PRESET_IDS },
    durationInFrames: {
      type: "integer" as const,
      description: "How long the animation takes. 8-16 is usual; omit for 12.",
    },
  },
  required: ["preset"],
};

export const DOC_TOOLS: Anthropic.Tool[] = [
  {
    name: "move_item",
    description:
      "Move a clip or layer so it STARTS at an absolute frame. It stays on its own track and keeps its length. If another item is already there it lands in the nearest free gap instead of overlapping — items on one track never overlap; that is what tracks are for.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "An id from the document outline." },
        toFrame: { type: "integer", description: "Absolute composition frame to start at." },
      },
      required: ["itemId", "toFrame"],
    },
  },
  {
    name: "trim_item",
    description:
      "Drag one edge of an item to an absolute frame. The opposite edge stays put. For footage the source trim follows, so the same moment of the video keeps playing under that edge — trimming the left edge skips the start of the shot rather than sliding it.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        edge: { type: "string", enum: ["left", "right"] },
        toFrame: { type: "integer", description: "Absolute frame to drag that edge to." },
      },
      required: ["itemId", "edge", "toFrame"],
    },
  },
  {
    name: "split_item",
    description: "Cut one item in two at an absolute frame. Both halves keep playing the right footage.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" }, atFrame: { type: "integer" } },
      required: ["itemId", "atFrame"],
    },
  },
  {
    name: "delete_item",
    description:
      "Remove one item. With ripple:true everything after it on the SAME track slides left to close the gap — use that only for a single-track edit. To remove a stretch of the finished video use cut_range instead, which closes the hole on every track at once and keeps the layers in sync.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" }, ripple: { type: "boolean" } },
      required: ["itemId"],
    },
  },
  {
    name: "duplicate_item",
    description: "Copy an item onto its own track, immediately after itself.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
    },
  },
  {
    name: "move_item_to_track",
    description:
      "Move an item onto a different track, optionally to a new start frame. Later tracks render IN FRONT, so this is how something is brought forward or sent behind.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        trackId: { type: "string" },
        toFrame: { type: "integer", description: "Omit to keep its current start frame." },
      },
      required: ["itemId", "trackId"],
    },
  },
  {
    name: "set_layout",
    description:
      "Position, size, rotate or fade an item on the canvas, in composition pixels. Only the fields given change.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        rotation: { type: "number", description: "Degrees clockwise." },
        opacity: { type: "number", description: "0 to 1." },
        cornerRadius: { type: "number" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "update_item",
    description:
      "Change what an item IS rather than where it sits: the words of a text layer, its size/colour/weight/alignment, a solid's colour, a clip's volume, fades, speed, an image's fit, or a caption layer's styling. Only the fields given change.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        text: { type: "string", description: "text layers only." },
        fontSize: { type: "number" },
        fontWeight: { type: "number" },
        color: { type: "string", description: "Hex, e.g. #F86606. Also a solid's colour." },
        align: { type: "string", enum: ["left", "center", "right"] },
        lineHeight: { type: "number" },
        letterSpacing: { type: "number" },
        backgroundColor: { type: "string" },
        volume: { type: "number", description: "0 to 1, video/audio only." },
        fadeInFrames: { type: "integer" },
        fadeOutFrames: { type: "integer" },
        playbackRate: { type: "number", description: "1 is normal speed." },
        fit: { type: "string", enum: ["cover", "contain", "fill"], description: "image/gif only." },
        highlightColor: { type: "string", description: "captions only — the word being spoken." },
        pageDurationMs: { type: "integer", description: "captions only." },
        maxWordsPerPage: { type: "integer", description: "captions only." },
      },
      required: ["itemId"],
    },
  },
  {
    name: "set_animation",
    description:
      "Set how an item arrives and leaves. The presets are the only ones this project allows — rise, settle, drift and pop each combine two transforms, type and words decompose text, and none is a straight cut. There is deliberately no blur, no fade from or to black, and no slide or wipe. Pass none to clear.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        in: ANIM_SPEC,
        out: ANIM_SPEC,
      },
      required: ["itemId"],
    },
  },
  {
    name: "add_text",
    description:
      "Add a text layer. Defaults to Inter — the only licensed face here besides GT Walsheim — centred in the frame, if no box is given.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        fromFrame: { type: "integer", description: "Omit to place at the playhead." },
        durationInFrames: { type: "integer", description: "Omit for 2 seconds." },
        trackId: { type: "string", description: "Omit to pick a track with room there." },
        fontSize: { type: "number" },
        color: { type: "string" },
        align: { type: "string", enum: ["left", "center", "right"] },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["text"],
    },
  },
  {
    name: "add_solid",
    description: "Add a solid colour block — a background, a bar, a band behind text.",
    input_schema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Hex." },
        fromFrame: { type: "integer" },
        durationInFrames: { type: "integer" },
        trackId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["color"],
    },
  },
  {
    name: "add_media",
    description:
      "Place ONE of the project's own footage or audio files on a track. Name it by filename exactly as listed in the outline. To lay several clips out one after another, use sequence_media instead — calling this repeatedly stacks them.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Filename from the FOOTAGE AVAILABLE list." },
        fromFrame: { type: "integer", description: "Omit to place at the playhead." },
        atEnd: {
          type: "boolean",
          description:
            "Place it AFTER everything already on the track instead of at a frame. This is what you want when adding a clip to the end of a cut.",
        },
        durationInFrames: { type: "integer", description: "Omit to use the whole file." },
        sourceInSec: { type: "number", description: "Seconds into the file to start from." },
        trackId: { type: "string" },
      },
      required: ["file"],
    },
  },
  {
    name: "sequence_media",
    description:
      "Lay several footage or audio files out one after another on a SINGLE track, gapless, in the order given. This is how you assemble a cut from a pile of clips. Use it instead of calling add_media once per file — add_media places each clip at the playhead, so repeated calls stack them all on top of each other on separate tracks.",
    input_schema: {
      type: "object",
      properties: {
        clips: {
          type: "array",
          description: "The clips to lay down, in the order they should play.",
          items: {
            type: "object",
            properties: {
              file: { type: "string", description: "Filename from the FOOTAGE AVAILABLE list." },
              sourceInSec: { type: "number", description: "Seconds into the file to start from." },
              sourceOutSec: { type: "number", description: "Seconds into the file to stop at." },
            },
            required: ["file"],
          },
        },
        trackId: { type: "string", description: "Omit to use the first track with room." },
        fromFrame: { type: "integer", description: "Where the run starts. Omit to append after what's already there." },
      },
      required: ["clips"],
    },
  },
  {
    name: "add_captions",
    description:
      "Put the spoken words of one clip on screen as a caption layer, sitting exactly over that clip. Only works where a transcript is available.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The video or audio item to caption." },
        fontSize: { type: "number" },
        color: { type: "string" },
        highlightColor: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "list_snippets",
    description:
      "List the project's branded scenes — the ready-made, on-brand blocks (end card, lower third, stat callout, intro card and so on). Use one of these rather than building a card out of text and shapes: they are the house look, they animate correctly, and the person can reopen and reword one afterwards.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "describe_snippet",
    description:
      "The words and settings one branded scene accepts, with their defaults. Call this before add_snippet whenever you intend to change any of its text — guessing a parameter name does nothing.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "A snippet id from list_snippets." } },
      required: ["id"],
    },
  },
  {
    name: "add_snippet",
    description:
      "Place a branded scene on the timeline, optionally with your own words in it. Its length comes from the scene itself, converted to this document's frame rate. Anything you place here stays editable: the person can reopen its form and reword it later.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A snippet id from list_snippets." },
        values: {
          type: "object",
          description:
            "Parameter values, keyed exactly as describe_snippet lists them. Omit to use the scene's own defaults.",
        },
        fromFrame: { type: "integer", description: "Omit to place at the playhead." },
        atEnd: { type: "boolean", description: "Place it after everything already on the track — the usual choice for an end card." },
        durationInFrames: { type: "integer", description: "Omit to use the scene's own length, which is almost always right." },
        trackId: { type: "string", description: "Omit to pick a track with room. A card that should sit OVER footage needs its own track." },
      },
      required: ["id"],
    },
  },
  {
    name: "add_track",
    description: "Add an empty track on top. Later tracks render in front of earlier ones.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  },
  {
    name: "remove_track",
    description: "Delete a track and everything on it. The last remaining track cannot be removed.",
    input_schema: {
      type: "object",
      properties: { trackId: { type: "string" } },
      required: ["trackId"],
    },
  },
  {
    name: "read_transcript",
    description:
      "Read what is said, with the exact frame each word lands on. Use this before cutting anything by what was said — never guess at where a phrase falls.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Omit for every clip in the document." },
        fromFrame: { type: "integer", description: "Optional window." },
        toFrame: { type: "integer" },
      },
    },
  },
  {
    name: "read_source_transcript",
    description:
      "Read what is said in one of the project's FOOTAGE FILES, whether or not it is on the timeline yet. Times come back in seconds into that file — exactly what sequence_media takes for sourceInSec/sourceOutSec, so a passage you pick here transfers with no arithmetic. This is how you choose what to use when assembling a cut from scratch.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Filename from the FOOTAGE AVAILABLE list." },
        fromSec: { type: "number", description: "Optional window, seconds into the file." },
        toSec: { type: "number" },
      },
      required: ["file"],
    },
  },
  {
    name: "find_gaps",
    description:
      "Find the pauses — stretches where nothing is being said, as frame ranges ready for cut_range. This is how 'cut the dead air' is done. A little air is left either side of the surviving speech so the cut does not clip the next word.",
    input_schema: {
      type: "object",
      properties: {
        minSeconds: { type: "number", description: "Shortest pause worth cutting. Default 0.6." },
      },
    },
  },
  {
    name: "cut_range",
    description:
      "Remove one or more stretches of the finished video and close the holes across EVERY track at once, so music and titles stay in sync with the footage. Clips crossing an edge are split automatically. This is the right tool for 'cut the dead air', 'lose that sentence', or 'take 10 seconds out'. Pass ALL the ranges you want gone in a single call — they are applied back-to-front for you, so every frame number you measured stays correct. Do NOT call this once per gap.",
    input_schema: {
      type: "object",
      properties: {
        ranges: {
          type: "array",
          description: "Every stretch to remove, in any order. Frames from the outline as it stands now.",
          items: {
            type: "object",
            properties: {
              fromFrame: { type: "integer" },
              toFrame: { type: "integer", description: "Exclusive." },
            },
            required: ["fromFrame", "toFrame"],
          },
        },
        fromFrame: { type: "integer", description: "Shorthand for a single range." },
        toFrame: { type: "integer", description: "Shorthand for a single range." },
        ripple: {
          type: "boolean",
          description: "Default true. false leaves the holes instead of closing them.",
        },
      },
    },
  },
];

// ── applying them ───────────────────────────────────────────────────────────

class ToolError extends Error {}

function requireItem(doc: EditorDoc, itemId: unknown): { item: EditorItem; trackId: string } {
  if (typeof itemId !== "string" || !itemId) throw new ToolError("itemId is required.");
  const found = findItem(doc, itemId);
  if (!found) {
    const ids = allItems(doc).map(({ item }) => item.id);
    throw new ToolError(
      `No item "${itemId}". Ids in this document: ${ids.join(", ") || "(none)"}. Use one of those exactly.`,
    );
  }
  return { item: found.item, trackId: found.track.id };
}

function requireTrack(doc: EditorDoc, trackId: unknown): string {
  if (typeof trackId !== "string" || !trackId) throw new ToolError("trackId is required.");
  if (!doc.tracks.some((t) => t.id === trackId)) {
    throw new ToolError(
      `No track "${trackId}". Tracks: ${doc.tracks.map((t) => t.id).join(", ")}.`,
    );
  }
  return trackId;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.length ? v : undefined;
}

function animSpec(raw: unknown, itemType: string, which: string) {
  if (raw == null) return undefined;
  const o = raw as Record<string, unknown>;
  const preset = o.preset;
  if (typeof preset !== "string" || !PRESET_IDS.includes(preset as AnimationPreset)) {
    throw new ToolError(`${which}.preset must be one of: ${PRESET_IDS.join(", ")}.`);
  }
  const allowed = presetsFor(itemType).map((p) => p.id);
  if (!allowed.includes(preset as AnimationPreset)) {
    throw new ToolError(
      `"${preset}" decomposes text, so it cannot apply to a ${itemType}. Available: ${allowed.join(", ")}.`,
    );
  }
  const d = typeof o.durationInFrames === "number" ? Math.round(o.durationInFrames) : 12;
  return { preset: preset as AnimationPreset, durationInFrames: d > 0 ? d : 12 };
}

/** The transcript words of the whole document, ready to search. */
function transcriptOf(doc: EditorDoc, ctx: AgentContext, itemId?: string) {
  const words = docTranscript(doc, ctx.transcripts ?? {}, doc.size.fps || ctx.fps, { itemId });
  if (!words.length) {
    throw new ToolError(
      itemId
        ? `No transcript for "${itemId}". Only video and audio clips with transcribed speech have one.`
        : "No transcript is available for this document, so nothing can be located by what is said.",
    );
  }
  return words;
}

/**
 * Run one tool against the document.
 *
 * Always returns a document: on a bad argument the ORIGINAL comes back untouched
 * alongside `isError`, so the model can be handed the reason and correct itself
 * without anything having been written. The validity check at the end is the
 * backstop — `isValidDoc` was dead code until now, and a model is exactly the
 * kind of caller that finds the case a mouse never could.
 */
export function applyDocTool(
  doc: EditorDoc,
  name: string,
  rawInput: unknown,
  ctx: AgentContext,
): ToolOutcome {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const fps = doc.size.fps || ctx.fps;
  const playhead = ctx.playheadFrame ?? 0;

  try {
    const next = run();
    if (next.doc !== doc && !isValidDoc(next.doc)) {
      return {
        doc,
        isError: true,
        result:
          "That edit would have left two items overlapping on one track, so it was not applied. Items on a track may never overlap — put the second one on another track, or move it clear.",
      };
    }
    return next;
  } catch (e) {
    if (e instanceof ToolError) return { doc, result: e.message, isError: true };
    const message = e instanceof Error ? e.message : String(e);
    return { doc, result: `Tool failed: ${message}`, isError: true };
  }

  function run(): ToolOutcome {
    switch (name) {
      case "move_item": {
        const { item } = requireItem(doc, input.itemId);
        const to = num(input, "toFrame");
        if (to == null) throw new ToolError("toFrame is required.");
        const next = moveItem(doc, item.id, Math.round(to) - item.from);
        const landed = findItem(next, item.id)!.item;
        return {
          doc: next,
          result:
            landed.from === Math.round(to)
              ? `Moved ${item.id} to frame ${landed.from} (${secs(landed.from, fps)}s).`
              : `Frame ${Math.round(to)} was occupied, so ${item.id} landed at the nearest free spot: frame ${landed.from} (${secs(landed.from, fps)}s).`,
        };
      }

      case "trim_item": {
        const { item } = requireItem(doc, input.itemId);
        const edge = str(input, "edge");
        const to = num(input, "toFrame");
        if (edge !== "left" && edge !== "right") throw new ToolError('edge must be "left" or "right".');
        if (to == null) throw new ToolError("toFrame is required.");
        const current = edge === "left" ? item.from : item.from + item.durationInFrames;
        const next = trimItem(doc, item.id, edge, Math.round(to) - current, fps);
        const after = findItem(next, item.id)!.item;
        return {
          doc: next,
          result: `Trimmed ${item.id}: now ${span(after.from, after.durationInFrames, fps)}.`,
        };
      }

      case "split_item": {
        const { item } = requireItem(doc, input.itemId);
        const at = num(input, "atFrame");
        if (at == null) throw new ToolError("atFrame is required.");
        const frame = Math.round(at);
        if (frame <= item.from || frame >= item.from + item.durationInFrames) {
          throw new ToolError(
            `Frame ${frame} is not inside ${item.id}, which runs ${span(item.from, item.durationInFrames, fps)}. Split somewhere between those.`,
          );
        }
        const next = splitItem(doc, item.id, frame, fps);
        const made = allItems(next).find(({ item: i }) => i.from === frame && i.id !== item.id);
        return {
          doc: next,
          result: `Split ${item.id} at frame ${frame}. The second half is ${made?.item.id ?? "a new item"}.`,
        };
      }

      case "delete_item": {
        const { item } = requireItem(doc, input.itemId);
        const ripple = input.ripple === true;
        const next = ripple ? rippleRemoveItem(doc, item.id) : removeItem(doc, item.id);
        return {
          doc: next,
          result: ripple
            ? `Deleted ${item.id} and closed the gap on its own track. (Other tracks did not move — use cut_range if they should have.)`
            : `Deleted ${item.id}.`,
        };
      }

      case "duplicate_item": {
        const { item } = requireItem(doc, input.itemId);
        const next = duplicateItem(doc, item.id);
        return { doc: next, result: `Duplicated ${item.id}.` };
      }

      case "move_item_to_track": {
        const { item } = requireItem(doc, input.itemId);
        const trackId = requireTrack(doc, input.trackId);
        const to = num(input, "toFrame") ?? item.from;
        const next = moveItemToTrack(doc, item.id, trackId, Math.round(to));
        const landed = findItem(next, item.id)!;
        return {
          doc: next,
          result: `Moved ${item.id} to track ${landed.track.id} at frame ${landed.item.from}.`,
        };
      }

      case "set_layout": {
        const { item } = requireItem(doc, input.itemId);
        const patch: Record<string, number> = {};
        for (const key of ["x", "y", "width", "height", "rotation", "opacity", "cornerRadius"]) {
          const v = num(input, key);
          if (v != null) patch[key] = v;
        }
        if (!Object.keys(patch).length) throw new ToolError("Give at least one of x, y, width, height, rotation, opacity, cornerRadius.");
        return {
          doc: setLayout(doc, item.id, patch),
          result: `Set ${Object.entries(patch).map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`).join(", ")} on ${item.id}.`,
        };
      }

      case "update_item": {
        const { item } = requireItem(doc, input.itemId);
        const changed: string[] = [];
        const patch: Record<string, unknown> = {};

        if (item.type === "text" || item.type === "captions") {
          const style: Partial<TextStyle> = {};
          for (const [key, get] of [
            ["fontSize", () => num(input, "fontSize")],
            ["fontWeight", () => num(input, "fontWeight")],
            ["lineHeight", () => num(input, "lineHeight")],
            ["letterSpacing", () => num(input, "letterSpacing")],
            ["color", () => str(input, "color")],
            ["align", () => str(input, "align")],
            ["backgroundColor", () => str(input, "backgroundColor")],
          ] as const) {
            const v = get();
            if (v != null) {
              (style as Record<string, unknown>)[key] = v;
              changed.push(key);
            }
          }
          if (Object.keys(style).length) patch.style = { ...item.style, ...style };
          if (item.type === "text") {
            const text = typeof input.text === "string" ? input.text : undefined;
            if (text != null) { patch.text = text; changed.push("text"); }
          } else {
            for (const key of ["highlightColor"]) {
              const v = str(input, key);
              if (v != null) { patch[key] = v; changed.push(key); }
            }
            for (const key of ["pageDurationMs", "maxWordsPerPage"]) {
              const v = num(input, key);
              if (v != null) { patch[key] = Math.round(v); changed.push(key); }
            }
          }
        } else if (item.type === "solid") {
          const color = str(input, "color");
          if (color != null) { patch.color = color; changed.push("color"); }
        } else if (item.type === "image" || item.type === "gif") {
          const fit = str(input, "fit");
          if (fit === "cover" || fit === "contain" || fit === "fill") { patch.fit = fit; changed.push("fit"); }
        }

        if (hasSource(item)) {
          const volume = num(input, "volume");
          if (volume != null) { patch.volume = Math.max(0, Math.min(1, volume)); changed.push("volume"); }
          for (const key of ["fadeInFrames", "fadeOutFrames"]) {
            const v = num(input, key);
            if (v != null) { patch[key] = Math.max(0, Math.round(v)); changed.push(key); }
          }
          const rate = num(input, "playbackRate");
          if (rate != null && rate > 0) { patch.playbackRate = rate; changed.push("playbackRate"); }
        }

        if (!changed.length) {
          throw new ToolError(
            `Nothing in that request applies to a ${item.type}. Check which fields a ${item.type} has in the outline.`,
          );
        }
        return {
          doc: updateItem(doc, item.id, patch as Partial<EditorItem>),
          result: `Updated ${changed.join(", ")} on ${item.id}.`,
        };
      }

      case "set_animation": {
        const { item } = requireItem(doc, input.itemId);
        const animateIn = animSpec(input.in, item.type, "in");
        const animateOut = animSpec(input.out, item.type, "out");
        if (!animateIn && !animateOut) throw new ToolError("Give an in, an out, or both.");
        const patch: Record<string, unknown> = {};
        if (animateIn) patch.animateIn = animateIn;
        if (animateOut) patch.animateOut = animateOut;
        return {
          doc: updateItem(doc, item.id, patch as Partial<EditorItem>),
          result: `Set ${[animateIn && `entrance ${animateIn.preset}`, animateOut && `exit ${animateOut.preset}`].filter(Boolean).join(" and ")} on ${item.id}.`,
        };
      }

      case "add_text": {
        const text = str(input, "text");
        if (!text) throw new ToolError("text is required.");
        const from = Math.max(0, Math.round(num(input, "fromFrame") ?? playhead));
        const duration = Math.max(1, Math.round(num(input, "durationInFrames") ?? fps * 2));
        const w = Math.round(num(input, "width") ?? doc.size.width * 0.6);
        const h = Math.round(num(input, "height") ?? doc.size.height * 0.18);
        const item: TextItem = {
          type: "text",
          id: makeId("text"),
          from,
          durationInFrames: duration,
          layout: {
            x: Math.round(num(input, "x") ?? (doc.size.width - w) / 2),
            y: Math.round(num(input, "y") ?? (doc.size.height - h) / 2),
            width: w,
            height: h,
          },
          text,
          style: {
            // Inter and GT Walsheim are the only licensed faces here.
            fontFamily: "Inter, sans-serif",
            fontSize: Math.round(num(input, "fontSize") ?? doc.size.height * 0.09),
            fontWeight: 700,
            color: str(input, "color") ?? "#F4F4F5",
            align: (str(input, "align") as TextStyle["align"]) ?? "center",
          },
        };
        return place(item, input.trackId, from, duration, `Added text "${short(text, 40)}"`);
      }

      case "add_solid": {
        const color = str(input, "color");
        if (!color) throw new ToolError("color is required.");
        const from = Math.max(0, Math.round(num(input, "fromFrame") ?? playhead));
        const duration = Math.max(1, Math.round(num(input, "durationInFrames") ?? fps * 2));
        const item: SolidItem = {
          type: "solid",
          id: makeId("solid"),
          from,
          durationInFrames: duration,
          layout: {
            x: Math.round(num(input, "x") ?? 0),
            y: Math.round(num(input, "y") ?? 0),
            width: Math.round(num(input, "width") ?? doc.size.width),
            height: Math.round(num(input, "height") ?? doc.size.height),
          },
          color,
        };
        return place(item, input.trackId, from, duration, `Added a ${color} solid`);
      }

      case "add_media": {
        const file = str(input, "file");
        if (!file) throw new ToolError("file is required.");
        const media = findMedia(file);
        const trackId = input.trackId != null ? requireTrack(doc, input.trackId) : undefined;
        const from =
          input.atEnd === true
            ? trackEnd(doc, trackId)
            : Math.max(0, Math.round(num(input, "fromFrame") ?? playhead));
        const sourceIn = Math.max(0, num(input, "sourceInSec") ?? 0);
        const fallback = media.durationSec ? (media.durationSec - sourceIn) * fps : fps * 3;
        const duration = Math.max(1, Math.round(num(input, "durationInFrames") ?? fallback));

        const { doc: host, asset } = ensureAsset(doc, media, file);
        const item = mediaItem(asset, media.kind, from, duration, sourceIn);
        return place(item, input.trackId, from, duration, `Placed "${file}"`, host);
      }

      case "sequence_media": {
        const raw = input.clips;
        if (!Array.isArray(raw) || !raw.length) throw new ToolError("clips is required — give at least one.");
        const wanted = (raw as Record<string, unknown>[]).map((c, i) => {
          const file = str(c, "file");
          if (!file) throw new ToolError(`Clip ${i + 1} has no file.`);
          return { file, media: findMedia(file), inSec: num(c, "sourceInSec"), outSec: num(c, "sourceOutSec") };
        });

        // ONE track for the whole run. Laying a cut out means the clips follow
        // each other; picking a track per clip is what stacked them all at frame
        // zero on separate tracks.
        let host = doc;
        let trackId = input.trackId != null ? requireTrack(doc, input.trackId) : undefined;
        if (!trackId) {
          const empty = doc.tracks.find((t) => !t.items.length);
          trackId = empty?.id ?? doc.tracks[0]?.id;
          if (!trackId) {
            host = addTrack(doc);
            trackId = host.tracks[host.tracks.length - 1].id;
          }
        }

        let cursor = Math.max(
          0,
          Math.round(num(input, "fromFrame") ?? trackEnd(host, trackId)),
        );
        const placed: string[] = [];
        for (const w of wanted) {
          const sourceIn = Math.max(0, w.inSec ?? 0);
          const outSec = w.outSec ?? w.media.durationSec;
          const seconds = outSec != null ? outSec - sourceIn : undefined;
          const duration = Math.max(1, Math.round((seconds ?? 3) * fps));
          const withAsset = ensureAsset(host, w.media, w.file);
          host = withAsset.doc;
          const item = mediaItem(withAsset.asset, w.media.kind, cursor, duration, sourceIn);
          if (outSec != null) (item as VideoItem).sourceOut = outSec;
          host = addItem(host, trackId, item);
          placed.push(item.id);
          cursor += duration;
        }
        return {
          doc: host,
          result: `Laid ${placed.length} clip(s) end to end on track ${trackId}, finishing at frame ${cursor} (${secs(cursor, fps)}s). Ids: ${placed.join(", ")}.`,
        };
      }

      case "add_captions": {
        const { item } = requireItem(doc, input.itemId);
        if (!hasSource(item)) throw new ToolError(`${item.id} is a ${item.type} — only video and audio can be captioned.`);
        const words = transcriptOf(doc, ctx, item.id);
        // Caption times are relative to the CAPTIONS item, and the layer is laid
        // exactly over the clip — so dragging it later keeps the words on the
        // speech instead of drifting off it.
        const tokens: CaptionToken[] = words.map((w) => ({
          text: w.text,
          startSec: (w.fromFrame - item.from) / fps,
          endSec: (w.toFrame - item.from) / fps,
        }));
        const h = Math.round(doc.size.height * 0.22);
        const captions: CaptionsItem = {
          type: "captions",
          id: makeId("captions"),
          from: item.from,
          durationInFrames: item.durationInFrames,
          layout: {
            x: Math.round(doc.size.width * 0.08),
            y: Math.round(doc.size.height * 0.68),
            width: Math.round(doc.size.width * 0.84),
            height: h,
          },
          tokens,
          style: {
            fontFamily: "Inter, sans-serif",
            fontSize: Math.round(num(input, "fontSize") ?? doc.size.height * 0.06),
            fontWeight: 700,
            color: str(input, "color") ?? "#F4F4F5",
            align: "center",
          },
          highlightColor: str(input, "highlightColor") ?? "#F86606",
        };
        return place(
          captions,
          undefined,
          item.from,
          item.durationInFrames,
          `Captioned ${item.id} with ${tokens.length} words`,
        );
      }

      case "list_snippets": {
        const all = ctx.snippets ?? [];
        if (!all.length) throw new ToolError("The branded scene library is not available here.");
        const lines = all.map((sn) => {
          const params = settableKeys(sn.schema).length;
          const at = sceneFramesAtFps({ durationInFrames: sn.durationInFrames, fps: sn.fps }, fps);
          return `  ${sn.id} — ${sn.name}${sn.subtitle ? `: ${sn.subtitle}` : ""} · ${at}f (${secs(at, fps)}s)${params ? ` · ${params} settable` : " · no parameters"}`;
        });
        return {
          doc,
          result: `${all.length} branded scenes. Lengths are already converted to this document's ${fps}fps.\n${lines.join("\n")}`,
        };
      }

      case "describe_snippet": {
        const id = str(input, "id");
        const sn = findSnippet(id);
        const at = sceneFramesAtFps({ durationInFrames: sn.durationInFrames, fps: sn.fps }, fps);
        return {
          doc,
          result: `${sn.id} — ${sn.name}\nRuns ${at} frames (${secs(at, fps)}s) in this document.\nParameters:\n${describeParams(sn.schema)}`,
        };
      }

      case "add_snippet": {
        const id = str(input, "id");
        const sn = findSnippet(id);
        const values = (input.values ?? {}) as Record<string, unknown>;

        // renderSnippet walks the SCHEMA and skips anything it has no parameter
        // for, so a misspelt key is a silent no-op the model would believe had
        // worked. Reject it with the real list instead.
        const allowed = settableKeys(sn.schema);
        const unknown = Object.keys(values).filter((k) => !allowed.includes(k));
        if (unknown.length) {
          throw new ToolError(
            `${sn.id} has no parameter called ${unknown.map((u) => `"${u}"`).join(", ")}. It accepts: ${allowed.join(", ") || "(none)"}. Call describe_snippet first.`,
          );
        }

        const code = Object.keys(values).length && sn.schema
          ? renderSnippet(sn.code, sn.schema, values)
          : sn.code;

        // Its own length, restated at THIS document's rate — a 25fps scene needs
        // more frames in a 30fps document or it is cut off mid-animation.
        const natural = sceneFramesAtFps({ durationInFrames: sn.durationInFrames, fps: sn.fps }, fps);
        const duration = Math.max(1, Math.round(num(input, "durationInFrames") ?? natural));

        const trackId = input.trackId != null ? requireTrack(doc, input.trackId) : undefined;
        const from =
          input.atEnd === true
            ? trackEnd(doc, trackId)
            : Math.max(0, Math.round(num(input, "fromFrame") ?? playhead));

        const item: SceneItem = {
          type: "scene",
          id: makeId("snippet"),
          from,
          durationInFrames: duration,
          layout: fullFrameLayout(doc.size),
          // Restated in document units: a scene times its own exit against its
          // declared length, so a 30fps card dropped into a 25fps slot would
          // never reach the outro and would cut hard instead.
          code: retimeSceneCode(code, duration, fps),
          // The identity and the values it was built from. The substitution runs
          // ONE WAY, so without this the parameter form could never be reopened —
          // which is the difference between a block the person can reword and a
          // block they are stuck with.
          snippet: { id: sn.id, values },
          fit: "retime",
        };
        const set = Object.keys(values);
        return place(
          item, input.trackId, from, duration,
          `Placed "${sn.name}"${set.length ? ` with ${set.join(", ")} set` : " with its default text"}`,
        );
      }

      case "add_track": {
        const next = addTrack(doc, str(input, "name"));
        const made = next.tracks[next.tracks.length - 1];
        return { doc: next, result: `Added track ${made.id} "${made.name}" at the front.` };
      }

      case "remove_track": {
        const trackId = requireTrack(doc, input.trackId);
        if (doc.tracks.length <= 1) throw new ToolError("This is the only track — it cannot be removed.");
        return { doc: removeTrack(doc, trackId), result: `Removed track ${trackId} and its items.` };
      }

      case "read_transcript": {
        const itemId = str(input, "itemId");
        if (itemId) requireItem(doc, itemId);
        let words = transcriptOf(doc, ctx, itemId);
        const from = num(input, "fromFrame");
        const to = num(input, "toFrame");
        if (from != null || to != null) {
          words = wordsInRange(words, from ?? 0, to ?? Number.POSITIVE_INFINITY);
        }
        const lines = words.map(
          (w) => `${w.fromFrame}-${w.toFrame}f (${secs(w.fromFrame, fps)}s) ${w.text}`,
        );
        return {
          doc,
          result: `${words.length} words, each with the frames it lands on:\n${lines.join("\n")}`,
        };
      }

      case "read_source_transcript": {
        const file = str(input, "file");
        const media = findMedia(file ?? "");
        const words = ctx.mediaTranscripts?.[media.file];
        if (!words?.length) {
          throw new ToolError(
            `No transcript for "${media.file}" yet. Only footage that has been analysed has one; call transcribe_clip on a clip of it, or pick a file that does.`,
          );
        }
        const from = num(input, "fromSec") ?? 0;
        const to = num(input, "toSec") ?? Number.POSITIVE_INFINITY;
        const inWindow = words.filter((w) => w.end > from && w.start < to);
        if (!inWindow.length) throw new ToolError(`Nothing is said between ${from}s and ${to}s of ${media.file}.`);
        const lines = inWindow.map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)}s ${w.text.trim()}`);
        return {
          doc,
          result: `${inWindow.length} words in "${media.file}", timed in SECONDS INTO THE FILE — pass these straight to sequence_media as sourceInSec / sourceOutSec.\n${lines.join("\n")}`,
        };
      }

      case "find_gaps": {
        const words = transcriptOf(doc, ctx);
        const minSeconds = num(input, "minSeconds") ?? 0.6;
        const gaps = silenceGaps(words, { minSeconds, fps });
        if (!gaps.length) {
          return { doc, result: `No pauses of ${minSeconds}s or longer. Nothing to cut.` };
        }
        const total = gaps.reduce((s, g) => s + g.seconds, 0);
        const lines = gaps.map(
          (g) =>
            `${g.fromFrame}-${g.toFrame}f — ${g.seconds.toFixed(2)}s of silence after "${g.after}" and before "${g.before}"`,
        );
        return {
          doc,
          result: `${gaps.length} pause(s), ${total.toFixed(2)}s in total. Pass them ALL to cut_range in one call — it applies them back-to-front so these frame numbers stay correct.\n${lines.join("\n")}`,
        };
      }

      case "cut_range": {
        const raw = Array.isArray(input.ranges)
          ? (input.ranges as Record<string, unknown>[])
          : [{ fromFrame: input.fromFrame, toFrame: input.toFrame }];
        const ranges = raw.map((r, i) => {
          const from = num(r, "fromFrame");
          const to = num(r, "toFrame");
          if (from == null || to == null) {
            throw new ToolError(`Range ${i + 1} needs both fromFrame and toFrame.`);
          }
          const a = Math.max(0, Math.round(Math.min(from, to)));
          const b = Math.round(Math.max(from, to));
          if (b - a < 1) throw new ToolError(`Range ${i + 1} (${a}-${b}) is empty — toFrame must be past fromFrame.`);
          return { a, b };
        });
        if (!ranges.length) throw new ToolError("Give at least one range to cut.");

        // Overlapping ranges would double-count once the first is closed up.
        const ordered = [...ranges].sort((x, y) => x.a - y.a);
        for (let i = 1; i < ordered.length; i++) {
          if (ordered[i].a < ordered[i - 1].b) {
            throw new ToolError(
              `Ranges ${ordered[i - 1].a}-${ordered[i - 1].b} and ${ordered[i].a}-${ordered[i].b} overlap. Merge them into one.`,
            );
          }
        }

        const before = docDuration(doc);
        const ripple = input.ripple !== false;
        // Back to front, so each cut's frames are still the ones that were
        // measured. Doing this here rather than asking the model to remember it
        // is the difference between a reliable edit and a subtly wrong one.
        let next = doc;
        for (const { a, b } of [...ordered].reverse()) {
          next = cutRange(next, a, b, fps, { ripple });
        }
        const after = docDuration(next);
        const removed = ordered.reduce((sum, r) => sum + (r.b - r.a), 0);
        return {
          doc: next,
          result: `Cut ${ordered.length} range(s), ${(removed / fps).toFixed(2)}s in total${ripple ? ", closing the holes on every track" : ""}. The video is now ${secs(after, fps)}s, was ${secs(before, fps)}s.`,
        };
      }

      default:
        throw new ToolError(`Unknown tool "${name}".`);
    }
  }

  /** The frame after everything on a track — or on the whole document. */
  function trackEnd(d: EditorDoc, trackId?: string): number {
    const tracks = trackId ? d.tracks.filter((t) => t.id === trackId) : d.tracks;
    let end = 0;
    for (const t of tracks) {
      for (const i of t.items) end = Math.max(end, i.from + i.durationInFrames);
    }
    return end;
  }

  function findSnippet(id: string | undefined): SnippetEntry {
    if (!id) throw new ToolError("id is required — call list_snippets for the ids.");
    const all = ctx.snippets ?? [];
    const found = all.find((sn) => sn.id === id) ?? all.find((sn) => sn.id.toLowerCase() === id.toLowerCase());
    if (!found) {
      throw new ToolError(
        `No branded scene called "${id}". Available: ${all.map((sn) => sn.id).join(", ") || "(none)"}.`,
      );
    }
    return found;
  }

  function findMedia(file: string) {
    const media = ctx.mediaFiles?.find((m) => m.file === file || m.file.endsWith(`/${file}`));
    if (!media) {
      throw new ToolError(
        `No footage called "${file}". Available: ${(ctx.mediaFiles ?? []).map((m) => m.file).join(", ") || "(none — this project has no media)"}.`,
      );
    }
    return media;
  }

  /** Register a source file once, however many clips play from it. */
  function ensureAsset(
    d: EditorDoc,
    media: NonNullable<AgentContext["mediaFiles"]>[number],
    file: string,
  ): { doc: EditorDoc; asset: Asset } {
    const existing = d.assets.find((a) => a.src === media.src);
    if (existing) return { doc: d, asset: existing };
    const asset: Asset = {
      id: makeId("asset"),
      kind: media.kind,
      src: media.src,
      name: file,
      durationSec: media.durationSec,
      width: media.width,
      height: media.height,
    };
    return { doc: addAsset(d, asset), asset };
  }

  function mediaItem(
    asset: Asset,
    kind: AssetKind,
    from: number,
    durationInFrames: number,
    sourceIn: number,
  ): EditorItem {
    const base = {
      id: makeId(kind),
      from,
      durationInFrames,
      layout: { x: 0, y: 0, width: doc.size.width, height: doc.size.height },
      assetId: asset.id,
      sourceIn,
    };
    return (kind === "audio"
      ? { ...base, type: "audio" as const }
      : kind === "image"
        ? { ...base, type: "image" as const, fit: "cover" as const }
        : { ...base, type: "video" as const }) as EditorItem;
  }

  /** Put a freshly-made item on a named track, or on one with room there. */
  function place(
    item: EditorItem,
    trackId: unknown,
    from: number,
    duration: number,
    what: string,
    host: EditorDoc = doc,
  ): ToolOutcome {
    const target = trackId != null ? requireTrack(host, trackId) : undefined;
    const { doc: withTrack, trackId: landing } = target
      ? { doc: host, trackId: target }
      : trackWithRoomAt(host, from, duration);
    const next = addItem(withTrack, landing, item);
    const landed = findItem(next, item.id)?.item ?? item;
    return {
      doc: next,
      result: `${what} as ${item.id} on track ${landing}, ${span(landed.from, landed.durationInFrames, fps)}.`,
    };
  }
}

/**
 * The tool list with the real snippet ids pinned into the two tools that take
 * one. Tools sit BEFORE the system block in the cache prefix, so the enum rides
 * the prompt cache; putting the library in `describeDoc` instead would land it
 * in the last user message and be re-paid on every single turn.
 */
export function toolsWithSnippets(tools: Anthropic.Tool[], ids: string[]): Anthropic.Tool[] {
  if (!ids.length) return tools.filter((t) => !t.name.endsWith("_snippet") && t.name !== "list_snippets");
  return tools.map((t) => {
    if (t.name !== "add_snippet" && t.name !== "describe_snippet") return t;
    const schema = t.input_schema as { properties?: Record<string, unknown> };
    return {
      ...t,
      input_schema: {
        ...t.input_schema,
        properties: {
          ...schema.properties,
          id: { type: "string", enum: ids, description: "A branded scene id." },
        },
      },
    } as Anthropic.Tool;
  });
}

/** Names the route dispatches here, rather than handling itself. */
export const DOC_TOOL_NAMES = new Set(DOC_TOOLS.map((t) => t.name));

/** Tools that only read — they never need a re-render or an undo entry. */
export const READ_ONLY_TOOLS = new Set(["read_transcript", "find_gaps"]);
