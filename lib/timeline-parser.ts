export interface TimelineClip {
  name: string;
  src: string;
  from: number;
  durationInFrames: number;
  startFrom?: number;
  endAt?: number;
  type: "video" | "audio" | "image" | "scene";
}

// Palette for clip colors
const CLIP_COLORS = [
  "oklch(0.72 0.26 340)",  // magenta
  "oklch(0.82 0.14 210)",  // cyan
  "oklch(0.82 0.16 75)",   // amber
  "oklch(0.88 0.22 124)",  // lime
  "oklch(0.72 0.20 280)",  // purple
  "oklch(0.78 0.18 160)",  // teal
];

export function getClipColor(index: number): string {
  return CLIP_COLORS[index % CLIP_COLORS.length];
}

function extractFilename(src: string): string {
  const parts = src.split("/");
  return parts[parts.length - 1] || src;
}

function resolveNumericExpr(expr: string, constants: Record<string, number>): number | null {
  // Trim
  let s = expr.trim();

  // Direct number
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  // Simple math: "150 + 300", "TRANSITION + 200", etc.
  // Replace known constants
  for (const [name, value] of Object.entries(constants)) {
    s = s.replace(new RegExp(`\\b${name}\\b`, "g"), String(value));
  }

  // Try to evaluate simple arithmetic
  if (/^[\d\s+\-*/().]+$/.test(s)) {
    try {
      const result = Function(`"use strict"; return (${s})`)();
      if (typeof result === "number" && !isNaN(result)) return Math.round(result);
    } catch {
      // fallback
    }
  }

  return null;
}

/**
 * Source-mapped view of a `<Sequence from={N} durationInFrames={N}>...</Sequence>`
 * block. Used by the editable-timeline scene mode to patch numeric attributes
 * in place without regenerating the whole composition.
 *
 * Only handles plain `<Sequence>`; `TransitionSeries.Sequence` /
 * `Series.Sequence` are excluded because their `from` is implicit.
 */
export type BlockKind = "video" | "audio" | "scene";

export interface SequenceBlock {
  from: number;
  durationInFrames: number;
  blockStart: number;          // index of the opening "<"
  blockEnd: number;            // index just past the closing "</Sequence>"
  fromValueStart: number;      // index of the first char of the value inside from={...}
  fromValueEnd: number;        // index of the closing "}" of from={...}
  durationValueStart: number;
  durationValueEnd: number;
  hasNonNumericFrom: boolean;       // true if the attribute value isn't a bare integer
  hasNonNumericDuration: boolean;
  /** What the block holds: a video/audio leaf, or authored JSX (scene/overlay). */
  kind: BlockKind;
  src?: string;
  /** Human-readable name for the timeline: the file name, or the component. */
  label: string;
  /**
   * Source-media trim, read from the media tag's OWN byte range (so two
   * <Video> tags in one Sequence can't inherit each other's values).
   * `*Range` is null when the attribute isn't present; `mediaAttrInsertAt` is
   * then where one can be spliced in.
   */
  startFrom?: number;
  endAt?: number;
  startFromRange: { start: number; end: number } | null;
  endAtRange: { start: number; end: number } | null;
  mediaAttrInsertAt?: number;
  /** Media leaf found, but its trim attributes couldn't be mapped — don't patch it. */
  mediaUnmappable?: boolean;
}

function findAttrValueRange(
  source: string,
  openTagStart: number,
  openTagEnd: number,
  attrName: string,
): { start: number; end: number; raw: string } | null {
  const slice = source.slice(openTagStart, openTagEnd);
  const re = new RegExp(`\\b${attrName}\\s*=\\s*\\{`);
  const m = re.exec(slice);
  if (!m) return null;
  // Find the matching brace from the opening `{`.
  const openIdx = openTagStart + m.index + m[0].length - 1; // index of `{`
  let depth = 0;
  for (let i = openIdx; i < openTagEnd; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { start: openIdx + 1, end: i, raw: source.slice(openIdx + 1, i) };
      }
    }
  }
  return null;
}

/**
 * Both spellings of Remotion's source-trim props. `startFrom`/`endAt` are
 * deprecated in 4.x in favour of `trimBefore`/`trimAfter`; the runtime already
 * accepts either (see remotion/DynamicScene.tsx), so the parser must too —
 * otherwise the eventual rename silently empties the timeline.
 */
const TRIM_BEFORE_ATTR = "(?:startFrom|trimBefore)";
const TRIM_AFTER_ATTR = "(?:endAt|trimAfter)";

interface MediaTag {
  kind: "video" | "audio";
  src?: string;
  tagStart: number;
  tagEnd: number;   // index just past the closing ">"
  insertAt: number; // where a new attribute can be spliced into the open tag
}

/**
 * Locate the media leaf inside a Sequence block. Video wins over audio when a
 * block somehow holds both — video is the base track.
 */
function findMediaTag(code: string, blockStart: number, blockEnd: number): MediaTag | null {
  const slice = code.slice(blockStart, blockEnd);
  const re = /<(OffthreadVideo|Video|Audio)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  let audio: MediaTag | null = null;
  while ((m = re.exec(slice)) !== null) {
    const tagStart = blockStart + m.index;
    const tagEnd = tagStart + m[0].length;
    // Splice point for a new attribute: before "/>" on a self-closing tag,
    // otherwise before ">". Located by regex rather than lastIndexOf("/") so a
    // slash inside a src path can't be mistaken for the tag terminator.
    const selfClose = m[0].search(/\/\s*>$/);
    const insertAt = selfClose >= 0 ? tagStart + selfClose : tagEnd - 1;
    const srcMatch = /\bsrc=(?:\{\s*["'`]([^"'`]+)["'`]\s*\}|"([^"]+)")/.exec(m[0]);
    const tag: MediaTag = {
      kind: m[1] === "Audio" ? "audio" : "video",
      src: srcMatch ? srcMatch[1] || srcMatch[2] : undefined,
      tagStart,
      tagEnd,
      insertAt,
    };
    if (tag.kind === "video") return tag;
    if (!audio) audio = tag;
  }
  return audio;
}

export function parseSequenceBlocks(code: string, fps: number): SequenceBlock[] {
  if (!code || !code.trim()) return [];

  const constants: Record<string, number> = { fps };
  const constRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(\d+)/g;
  let cm: RegExpExecArray | null;
  while ((cm = constRegex.exec(code)) !== null) {
    constants[cm[1]] = parseInt(cm[2], 10);
  }
  const fpsExport = code.match(/export\s+(?:const|let|var)\s+fps\s*=\s*(\d+)/);
  if (fpsExport) constants.fps = parseInt(fpsExport[1], 10);

  const blocks: SequenceBlock[] = [];
  // Match opening tag <Sequence ...> (NOT TransitionSeries.Sequence / Series.Sequence).
  const openRe = /<Sequence\b([^>]*)>/g;
  let om: RegExpExecArray | null;
  while ((om = openRe.exec(code)) !== null) {
    const openStart = om.index;
    const openEnd = om.index + om[0].length;
    // Find matching </Sequence>, allowing nested <Sequence> within (shouldn't
    // happen for our use case, but cheap to support).
    let depth = 1;
    const nestedRe = /<Sequence\b|<\/Sequence>/g;
    nestedRe.lastIndex = openEnd;
    let blockEnd = -1;
    let nm: RegExpExecArray | null;
    while ((nm = nestedRe.exec(code)) !== null) {
      if (nm[0] === "</Sequence>") {
        depth--;
        if (depth === 0) {
          blockEnd = nm.index + nm[0].length;
          break;
        }
      } else {
        depth++;
      }
    }
    if (blockEnd === -1) continue;

    const fromRange = findAttrValueRange(code, openStart, openEnd, "from");
    const durRange = findAttrValueRange(code, openStart, openEnd, "durationInFrames");
    if (!fromRange || !durRange) continue;

    const fromVal = resolveNumericExpr(fromRange.raw, constants);
    const durVal = resolveNumericExpr(durRange.raw, constants);
    if (fromVal === null || durVal === null) continue;

    // Classify the block and, for media leaves, map the trim attributes so the
    // emitter can patch them in place instead of regenerating the file.
    const media = findMediaTag(code, openStart, blockEnd);
    let kind: BlockKind = "scene";
    let src: string | undefined;
    let startFrom: number | undefined;
    let endAt: number | undefined;
    let startFromRange: { start: number; end: number } | null = null;
    let endAtRange: { start: number; end: number } | null = null;
    let mediaAttrInsertAt: number | undefined;
    let mediaUnmappable: boolean | undefined;

    if (media) {
      kind = media.kind;
      src = media.src;
      mediaAttrInsertAt = media.insertAt;
      const sfRange = findAttrValueRange(code, media.tagStart, media.tagEnd, TRIM_BEFORE_ATTR);
      const eaRange = findAttrValueRange(code, media.tagStart, media.tagEnd, TRIM_AFTER_ATTR);
      if (sfRange) {
        const v = resolveNumericExpr(sfRange.raw, constants);
        if (v === null) mediaUnmappable = true;
        else {
          startFrom = v;
          startFromRange = { start: sfRange.start, end: sfRange.end };
        }
      }
      if (eaRange) {
        const v = resolveNumericExpr(eaRange.raw, constants);
        if (v === null) mediaUnmappable = true;
        else {
          endAt = v;
          endAtRange = { start: eaRange.start, end: eaRange.end };
        }
      }
    }

    blocks.push({
      label: blockLabel(code, openEnd, blockEnd, kind, src),
      from: fromVal,
      durationInFrames: durVal,
      blockStart: openStart,
      blockEnd,
      fromValueStart: fromRange.start,
      fromValueEnd: fromRange.end,
      durationValueStart: durRange.start,
      durationValueEnd: durRange.end,
      hasNonNumericFrom: !/^\s*\d+\s*$/.test(fromRange.raw),
      hasNonNumericDuration: !/^\s*\d+\s*$/.test(durRange.raw),
      kind,
      src,
      startFrom,
      endAt,
      startFromRange,
      endAtRange,
      mediaAttrInsertAt,
      mediaUnmappable,
    });
  }

  blocks.sort((a, b) => a.blockStart - b.blockStart);
  return blocks;
}

/**
 * Smart Trim emits `<Series><Series.Sequence durationInFrames={D}>…</Series.Sequence>…</Series>`,
 * where each child's `from` is implicit (a running total) and therefore can't be
 * patched in place. Rewrite it once into explicit
 * `<Sequence from={F} durationInFrames={D}>` blocks so the single patching
 * emitter can edit it like any other composition.
 *
 * Lossless: only the <Series> wrapper and the child tag names change — the
 * header comments and every media tag survive byte-for-byte. (This replaces the
 * old video-mode behaviour, which achieved the same flattening by regenerating
 * the entire file and discarding everything else in it.)
 *
 * Returns null when the shape isn't the plain one we understand — e.g. a
 * `Series.Sequence` carrying `offset`, whose timing we would silently change —
 * so the caller can fall back to read-only instead of guessing.
 */
/** Name a block for the timeline: the media file, or the component it renders. */
function blockLabel(
  code: string,
  contentStart: number,
  blockEnd: number,
  kind: BlockKind,
  src?: string,
): string {
  if (src) return extractFilename(src);
  // Scan the block's CONTENT, not its opening tag — otherwise every scene would
  // be named after the <Sequence> wrapping it.
  const inner = code.slice(contentStart, blockEnd);
  const component = /<([A-Z]\w*)\b/.exec(inner);
  if (component && component[1] !== "Sequence") return component[1];
  return kind === "audio" ? "Audio" : "Scene";
}

export function normalizeSeriesToSequences(code: string, fps: number): string | null {
  const openMatch = /<Series\s*>/.exec(code);
  const closeIdx = code.lastIndexOf("</Series>");
  if (!openMatch || closeIdx < 0 || closeIdx < openMatch.index) return null;
  if (/<TransitionSeries\b/.test(code)) return null;

  const constants: Record<string, number> = { fps };
  const constRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(\d+)/g;
  let cm: RegExpExecArray | null;
  while ((cm = constRegex.exec(code)) !== null) {
    constants[cm[1]] = parseInt(cm[2], 10);
  }
  const fpsExport = code.match(/export\s+(?:const|let|var)\s+fps\s*=\s*(\d+)/);
  if (fpsExport) constants.fps = parseInt(fpsExport[1], 10);

  const body = code.slice(openMatch.index + openMatch[0].length, closeIdx);
  const childRe = /<Series\.Sequence\b([^>]*)>([\s\S]*?)<\/Series\.Sequence>/g;
  const rewritten: string[] = [];
  let running = 0;
  let child: RegExpExecArray | null;
  while ((child = childRe.exec(body)) !== null) {
    const [, attrs, inner] = child;
    // `offset` shifts a child relative to the running total; flattening it to a
    // literal `from` would need maths we deliberately don't guess at.
    if (/\boffset\s*=/.test(attrs)) return null;
    const durMatch = /\bdurationInFrames\s*=\s*\{([^}]+)\}/.exec(attrs);
    if (!durMatch) return null;
    const dur = resolveNumericExpr(durMatch[1], constants);
    if (dur === null) return null;
    const otherAttrs = attrs
      .replace(/\bdurationInFrames\s*=\s*\{[^}]+\}/, "")
      .replace(/\s+/g, " ")
      .trim();
    const extra = otherAttrs ? ` ${otherAttrs}` : "";
    rewritten.push(
      `<Sequence from={${running}} durationInFrames={${dur}}${extra}>${inner}</Sequence>`,
    );
    running += dur;
  }
  if (rewritten.length === 0) return null;
  // Everything between the wrapper tags must be the children themselves plus
  // whitespace; anything else would be dropped by the rewrite.
  if (body.replace(childRe, "").trim() !== "") return null;

  // Re-indent to where <Series> sat, so the flattened blocks line up. Only
  // swallow the leading whitespace when <Series> is alone on its line —
  // otherwise cutting back to the line start would delete whatever shares it
  // (e.g. the enclosing <AbsoluteFill> opening tag).
  const lineStart = code.lastIndexOf("\n", openMatch.index - 1) + 1;
  const ownsLine = /^\s*$/.test(code.slice(lineStart, openMatch.index));
  const cutStart = ownsLine ? lineStart : openMatch.index;
  const indent = ownsLine ? code.slice(lineStart, openMatch.index) : "";
  // Wrap in a fragment: <Series> is one element, and the blocks replacing it are
  // N siblings. Without a parent that is a syntax error wherever <Series> was
  // the sole returned element (`return (<Series>…</Series>)`), which is exactly
  // how the generator writes it.
  const joined = [
    `${indent}<>`,
    ...rewritten.map((b) => `${indent}  ${b}`),
    `${indent}</>`,
  ].join("\n");

  let out =
    code.slice(0, cutStart) + joined + code.slice(closeIdx + "</Series>".length);

  // Swap the now-unused `Series` import for `Sequence`.
  out = out.replace(/(import\s*\{)([^}]*)(\}\s*from\s*["']remotion["'])/, (_m, a, names, b) => {
    const list = names
      .split(",")
      .map((n: string) => n.trim())
      .filter(Boolean)
      .filter((n: string) => n !== "Series");
    if (!list.includes("Sequence")) list.push("Sequence");
    return `${a} ${list.join(", ")} ${b}`;
  });

  return out;
}

export function parseTimeline(code: string, fps: number): TimelineClip[] {
  if (!code || !code.trim()) return [];

  const clips: TimelineClip[] = [];

  // Extract constants (const FOO = 123)
  const constants: Record<string, number> = { fps };
  const constRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(\d+)/g;
  let constMatch;
  while ((constMatch = constRegex.exec(code)) !== null) {
    constants[constMatch[1]] = parseInt(constMatch[2], 10);
  }

  // Also try to get fps and durationInFrames from exports
  const fpsExport = code.match(/export\s+(?:const|let|var)\s+fps\s*=\s*(\d+)/);
  if (fpsExport) constants.fps = parseInt(fpsExport[1], 10);

  // Pattern 1: <Sequence from={X} durationInFrames={Y}> containing video/audio/img
  const sequenceRegex = /<Sequence[^>]*?\bfrom=\{([^}]+)\}[^>]*?\bdurationInFrames=\{([^}]+)\}[^>]*?>([\s\S]*?)<\/Sequence>/g;
  const sequenceRegex2 = /<Sequence[^>]*?\bdurationInFrames=\{([^}]+)\}[^>]*?\bfrom=\{([^}]+)\}[^>]*?>([\s\S]*?)<\/Sequence>/g;

  function parseSequenceContent(from: number, duration: number, content: string) {
    const clipsBefore = clips.length;

    // Look for video sources
    const videoRegex = /<(?:OffthreadVideo|Video)\s[^>]*?src=(?:\{["`']([^"'`]+)["`']\}|"([^"]+)")[^>]*?\/?>/g;
    let vMatch;
    while ((vMatch = videoRegex.exec(content)) !== null) {
      const src = vMatch[1] || vMatch[2];
      // Read the trim off THIS tag (vMatch[0]), not the whole Sequence body —
      // otherwise two <Video> tags in one block both take the first one's
      // values. Accept the modern trimBefore/trimAfter spelling too.
      const startFromMatch = vMatch[0].match(/(?:startFrom|trimBefore)=\{(\d+)\}/);
      const endAtMatch = vMatch[0].match(/(?:endAt|trimAfter)=\{(\d+)\}/);

      clips.push({
        name: extractFilename(src),
        src,
        from,
        durationInFrames: duration,
        startFrom: startFromMatch ? parseInt(startFromMatch[1], 10) : undefined,
        endAt: endAtMatch ? parseInt(endAtMatch[1], 10) : undefined,
        type: "video",
      });
    }

    // Look for audio sources
    const audioRegex = /<Audio\s[^>]*?src=(?:\{["`']([^"'`]+)["`']\}|"([^"]+)")[^>]*?\/?>/g;
    let aMatch;
    while ((aMatch = audioRegex.exec(content)) !== null) {
      const src = aMatch[1] || aMatch[2];
      clips.push({
        name: extractFilename(src),
        src,
        from,
        durationInFrames: duration,
        type: "audio",
      });
    }

    // If THIS Sequence contributed no media clip, it's a scene/overlay. Scoped
    // to this call: the old global `clips.find(c => c.from === from && ...)`
    // dropped an overlay whenever it merely started on the same frame as some
    // earlier video or audio clip — exactly how captions sit over footage.
    if (clips.length === clipsBefore) {
      // Check for any meaningful content
      const hasContent = /<(?:div|h1|h2|p|span|AbsoluteFill|Img)\b/.test(content);
      if (hasContent) {
        // Try to extract a scene name from component usage or text content
        const componentMatch = content.match(/<(\w+Scene|\w+Overlay|\w+Title)\b/);
        const name = componentMatch ? componentMatch[1] : "Scene";
        clips.push({
          name,
          src: "",
          from,
          durationInFrames: duration,
          type: "scene",
        });
      }
    }
  }

  let sMatch;
  while ((sMatch = sequenceRegex.exec(code)) !== null) {
    const from = resolveNumericExpr(sMatch[1], constants);
    const duration = resolveNumericExpr(sMatch[2], constants);
    if (from !== null && duration !== null) {
      parseSequenceContent(from, duration, sMatch[3]);
    }
  }

  // Also match durationInFrames before from
  while ((sMatch = sequenceRegex2.exec(code)) !== null) {
    const duration = resolveNumericExpr(sMatch[1], constants);
    const from = resolveNumericExpr(sMatch[2], constants);
    if (from !== null && duration !== null) {
      parseSequenceContent(from, duration, sMatch[3]);
    }
  }

  // Pattern 2: <TransitionSeries.Sequence durationInFrames={Y}> — no `from`, sequential
  const tsRegex = /<TransitionSeries\.Sequence\s[^>]*?durationInFrames=\{([^}]+)\}[^>]*?>([\s\S]*?)<\/TransitionSeries\.Sequence>/g;
  const transitionRegex = /<TransitionSeries\.Transition[^>]*?durationInFrames=\{([^}]+)\}[^>]*?\/?>/g;

  // Only use TransitionSeries parsing if no regular Sequences were found
  if (clips.length === 0) {
    const transitionDurations: number[] = [];
    let tMatch;
    while ((tMatch = transitionRegex.exec(code)) !== null) {
      const d = resolveNumericExpr(tMatch[1], constants);
      if (d !== null) transitionDurations.push(d);
    }

    let runningFrame = 0;
    let transIdx = 0;
    while ((sMatch = tsRegex.exec(code)) !== null) {
      const duration = resolveNumericExpr(sMatch[1], constants);
      if (duration === null) continue;

      parseSequenceContent(runningFrame, duration, sMatch[2]);

      // Account for transition overlap
      const overlapDuration = transitionDurations[transIdx] || 0;
      runningFrame += duration - overlapDuration;
      transIdx++;
    }
  }

  // Pattern 3: <Series.Sequence durationInFrames={Y}> — no `from`, sequential, no transitions.
  // Used by Smart Trim output. Same as TransitionSeries but without overlap logic.
  if (clips.length === 0) {
    const seriesSeqRegex = /<Series\.Sequence\s[^>]*?durationInFrames=\{([^}]+)\}[^>]*?>([\s\S]*?)<\/Series\.Sequence>/g;
    let runningFrame = 0;
    while ((sMatch = seriesSeqRegex.exec(code)) !== null) {
      const duration = resolveNumericExpr(sMatch[1], constants);
      if (duration === null) continue;
      parseSequenceContent(runningFrame, duration, sMatch[2]);
      runningFrame += duration;
    }
  }

  // Sort by start frame
  clips.sort((a, b) => a.from - b.from);

  return clips;
}
