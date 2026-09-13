/**
 * Data-driven timeline editing.
 *
 * Many AI-authored video edits don't write clips out one-by-one — they declare a
 * data array of segments and a loop lays them out into `<Sequence>`s. The regex
 * timeline parser (lib/timeline-parser.ts) can't see those (positions are
 * computed at runtime), so the timeline showed nothing to cut.
 *
 * This module finds that driving array LITERAL, computes each element's
 * composition position/duration, and edits by patching the array source
 * (delete / reorder / trim). The composition's own layout loop then recomputes
 * everything, so the edit stays faithful and preserves the AI's structure
 * (title cards, lower-thirds, overlays).
 *
 * Safety: we only expose editing when our computed total length matches the
 * composition's real exported `durationInFrames`. If the array's placement rule
 * is one we can't reproduce (overlapping crossfades, one element → several
 * clips, etc.), the totals won't match and we return null → the timeline falls
 * back to read-only rather than making a wrong cut.
 */

export interface DataClip {
  id: string;
  index: number; // position within the array
  kind?: string;
  label: string;
  from: number;
  durationInFrames: number;
  // Byte range of the whole `{ ... }` element in the code.
  elementStart: number;
  elementEnd: number;
  // Editable numeric field ranges (for trimming), when present.
  startSec?: number;
  startSecRange?: { start: number; end: number };
  endSec?: number;
  endSecRange?: { start: number; end: number };
  durValue?: number;
  durRange?: { start: number; end: number };
  durUnit?: "sec" | "frame";
}

export interface DataTimeline {
  code: string;
  fps: number;
  arrayName: string;
  clips: DataClip[];
  total: number;
}

// ── constant resolution ──────────────────────────────────────────────────────

function buildConstants(code: string, fps: number): Record<string, number> {
  const constants: Record<string, number> = { fps };
  // `const NAME = <number>` and simple integer expressions.
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let m: RegExpExecArray | null;
  // Two passes so consts defined in terms of earlier consts resolve.
  for (let pass = 0; pass < 2; pass++) {
    re.lastIndex = 0;
    while ((m = re.exec(code)) !== null) {
      const name = m[1];
      if (name in constants) continue;
      const v = resolveNumericExpr(m[2].trim(), constants);
      if (v != null) constants[name] = v;
    }
  }
  const fpsExport = code.match(/export\s+(?:const|let|var)\s+fps\s*=\s*(\d+)/);
  if (fpsExport) constants.fps = parseInt(fpsExport[1], 10);
  return constants;
}

function resolveNumericExpr(expr: string, constants: Record<string, number>): number | null {
  let s = expr.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  for (const [name, value] of Object.entries(constants)) {
    s = s.replace(new RegExp(`\\b${name}\\b`, "g"), String(value));
  }
  // Allow Math.round/floor/ceil/max/min in constant expressions.
  s = s.replace(/Math\.(round|floor|ceil|max|min)/g, "Math.$1");
  if (/^[\d\s+\-*/().,]+$/.test(s.replace(/Math\.(round|floor|ceil|max|min)/g, ""))) {
    try {
      const result = Function(`"use strict"; return (${s})`)();
      if (typeof result === "number" && !isNaN(result)) return result;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ── array-literal scanning (string/comment aware) ────────────────────────────

/** Find the end index of the array/object opened at `openIdx` (pointing at [ or {). */
function matchBracket(code: string, openIdx: number): number {
  const open = code[openIdx];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    i = skipStringOrComment(code, i);
    const ch = code[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** If `i` starts a string/template/comment, return the index of its last char; else `i`. */
function skipStringOrComment(code: string, i: number): number {
  const ch = code[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    const quote = ch;
    for (let j = i + 1; j < code.length; j++) {
      if (code[j] === "\\") {
        j++;
        continue;
      }
      if (code[j] === quote) return j;
    }
    return code.length - 1;
  }
  if (ch === "/" && code[i + 1] === "/") {
    const nl = code.indexOf("\n", i);
    return nl === -1 ? code.length - 1 : nl - 1;
  }
  if (ch === "/" && code[i + 1] === "*") {
    const end = code.indexOf("*/", i + 2);
    return end === -1 ? code.length - 1 : end + 1;
  }
  return i;
}

/** Split the interior of an array `[a, b, c]` into top-level `{...}` element ranges. */
function splitObjectElements(code: string, arrOpen: number, arrClose: number): { start: number; end: number }[] {
  const els: { start: number; end: number }[] = [];
  let i = arrOpen + 1;
  while (i < arrClose) {
    const sc = skipStringOrComment(code, i);
    if (sc !== i) {
      i = sc + 1;
      continue;
    }
    if (code[i] === "{") {
      const end = matchBracket(code, i);
      if (end === -1 || end > arrClose) break;
      els.push({ start: i, end });
      i = end + 1;
    } else {
      i++;
    }
  }
  return els;
}

/** Find `field: value` within an element, returning the numeric value + its byte range. */
function findNumericField(
  code: string,
  elStart: number,
  elEnd: number,
  names: string[],
  constants: Record<string, number>,
): { value: number; range: { start: number; end: number } } | null {
  const slice = code.slice(elStart, elEnd + 1);
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*:\\s*([^,}\\n]+)`);
    const m = re.exec(slice);
    if (!m) continue;
    const raw = m[1].trim();
    const v = resolveNumericExpr(raw, constants);
    if (v == null) continue;
    // Byte range of the value expression (trimmed) within the whole code.
    const valStartInSlice = m.index + m[0].indexOf(m[1]);
    const start = elStart + valStartInSlice;
    return { value: v, range: { start, end: start + m[1].length } };
  }
  return null;
}

function findStringField(code: string, elStart: number, elEnd: number, names: string[]): string | null {
  const slice = code.slice(elStart, elEnd + 1);
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`);
    const m = re.exec(slice);
    if (m) return m[1].replace(/\\n/g, " ").trim();
  }
  return null;
}

// ── parse ────────────────────────────────────────────────────────────────────

/**
 * Parse the driving segment array, computing per-element from/dur. Returns null
 * if no array validates against the composition's exported duration.
 */
export function parseDataTimeline(code: string, fps: number, exportedDuration: number): DataTimeline | null {
  if (!code || !code.trim()) return null;
  const constants = buildConstants(code, fps);
  const cfps = constants.fps || fps;

  // Candidate arrays: `const NAME (: Type[])? = [ ... ]`.
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$<>., []*]*)?\s*=\s*\[/g;
  let dm: RegExpExecArray | null;
  const candidates: { name: string; arrOpen: number; arrClose: number }[] = [];
  while ((dm = declRe.exec(code)) !== null) {
    const arrOpen = code.indexOf("[", dm.index + dm[0].length - 1);
    if (arrOpen === -1) continue;
    const arrClose = matchBracket(code, arrOpen);
    if (arrClose === -1) continue;
    candidates.push({ name: dm[1], arrOpen, arrClose });
  }

  let best: DataTimeline | null = null;
  for (const cand of candidates) {
    const els = splitObjectElements(code, cand.arrOpen, cand.arrClose);
    if (els.length < 2) continue;

    const clips: DataClip[] = [];
    let cursor = 0;
    let ok = true;
    for (let idx = 0; idx < els.length; idx++) {
      const el = els[idx];
      const kind = findStringField(code, el.start, el.end, ["kind"]) ?? undefined;
      const startF = findNumericField(code, el.start, el.end, ["startSec", "start", "inS", "in"], constants);
      const endF = findNumericField(code, el.start, el.end, ["endSec", "end", "outS", "out"], constants);
      const durSecF = findNumericField(code, el.start, el.end, ["durSec", "durationSec", "seconds"], constants);
      const durF = findNumericField(code, el.start, el.end, ["dur", "durationInFrames", "durationFrames", "frames"], constants);

      let durationInFrames: number | null = null;
      let startSec: number | undefined;
      let startSecRange: { start: number; end: number } | undefined;
      let endSec: number | undefined;
      let endSecRange: { start: number; end: number } | undefined;
      let durValue: number | undefined;
      let durRange: { start: number; end: number } | undefined;
      let durUnit: "sec" | "frame" | undefined;

      if (startF && endF) {
        durationInFrames = Math.round((endF.value - startF.value) * cfps);
        startSec = startF.value;
        startSecRange = startF.range;
        endSec = endF.value;
        endSecRange = endF.range;
      } else if (durSecF) {
        durationInFrames = Math.round(durSecF.value * cfps);
        durValue = durSecF.value;
        durRange = durSecF.range;
        durUnit = "sec";
      } else if (durF) {
        durationInFrames = Math.round(durF.value);
        durValue = durF.value;
        durRange = durF.range;
        durUnit = "frame";
      }

      if (durationInFrames == null || durationInFrames < 1) {
        ok = false;
        break;
      }

      let label = findStringField(code, el.start, el.end, ["title", "topic", "label", "index", "text", "name", "heading"]);
      if (!label) {
        if (startSec != null && endSec != null) {
          label = `${kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Clip"} ${Math.round(startSec)}–${Math.round(endSec)}s`;
        } else {
          label = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : `Clip ${idx + 1}`;
        }
      }

      clips.push({
        id: `data_${idx}`,
        index: idx,
        kind,
        label,
        from: cursor,
        durationInFrames,
        elementStart: el.start,
        elementEnd: el.end,
        startSec,
        startSecRange,
        endSec,
        endSecRange,
        durValue,
        durRange,
        durUnit,
      });
      cursor += durationInFrames;
    }

    if (!ok) continue;
    // Validation gate: our computed total must match the composition's real
    // exported duration (small tolerance for rounding of overlaps/fades).
    const tol = Math.max(2, Math.round(cfps * 0.15));
    if (Math.abs(cursor - exportedDuration) > tol) continue;

    // Prefer the array that best matches the exported duration.
    if (!best || Math.abs(cursor - exportedDuration) < Math.abs(best.total - exportedDuration)) {
      best = { code, fps: cfps, arrayName: cand.name, clips, total: cursor };
    }
  }

  return best;
}

// ── edits (return patched code) ──────────────────────────────────────────────

/** Remove one string/comment-safe splice, expanding to swallow surrounding comma + blank line. */
function deleteElement(code: string, el: { elementStart: number; elementEnd: number }): string {
  let start = el.elementStart;
  let end = el.elementEnd + 1;
  // Swallow a trailing comma.
  let j = end;
  while (j < code.length && (code[j] === " " || code[j] === "\t")) j++;
  if (code[j] === ",") end = j + 1;
  // Swallow trailing inline whitespace + newline.
  while (end < code.length && (code[end] === " " || code[end] === "\t")) end++;
  if (code[end] === "\r") end++;
  if (code[end] === "\n") end++;
  // Swallow a leading comment line (e.g. `// Intro ...`) + indentation.
  const lineStart = code.lastIndexOf("\n", start - 1) + 1;
  const before = code.slice(lineStart, start);
  if (/^\s*$/.test(before)) {
    start = lineStart;
    // A comment on the line(s) directly above belongs to this element.
    let ps = code.lastIndexOf("\n", lineStart - 2) + 1;
    while (ps >= 0) {
      const line = code.slice(ps, code.indexOf("\n", ps) === -1 ? code.length : code.indexOf("\n", ps));
      if (/^\s*\/\/.*$/.test(line)) {
        start = ps;
        if (ps === 0) break;
        ps = code.lastIndexOf("\n", ps - 2) + 1;
      } else break;
    }
  }
  return code.slice(0, start) + code.slice(end);
}

export function dataRippleDelete(dt: DataTimeline, id: string): string {
  const el = dt.clips.find((c) => c.id === id);
  if (!el) return dt.code;
  return deleteElement(dt.code, el);
}

/** Delete several segments from the array literal at once (multi-select). */
export function dataRippleDeleteMany(dt: DataTimeline, ids: string[]): string {
  const idSet = new Set(ids);
  // Delete from last element to first so earlier byte offsets stay valid.
  const targets = dt.clips.filter((c) => idSet.has(c.id)).sort((a, b) => b.elementStart - a.elementStart);
  let code = dt.code;
  for (const el of targets) code = deleteElement(code, el);
  return code;
}

export function dataReorder(dt: DataTimeline, id: string, targetIndex: number): string {
  const ordered = [...dt.clips].sort((a, b) => a.index - b.index);
  const fromIdx = ordered.findIndex((c) => c.id === id);
  if (fromIdx === -1) return dt.code;

  // Extract each element's exact source text (with a normalized one-per-line layout).
  const texts = ordered.map((c) => dt.code.slice(c.elementStart, c.elementEnd + 1));
  const [movedText] = texts.splice(fromIdx, 1);
  const clamped = Math.max(0, Math.min(texts.length, targetIndex));
  texts.splice(clamped, 0, movedText);

  // Replace the entire element span (first element start → last element end) with
  // the reordered list, comma+newline separated at the array's indentation.
  const firstStart = Math.min(...ordered.map((c) => c.elementStart));
  const lastEnd = Math.max(...ordered.map((c) => c.elementEnd)) + 1;
  const lineStart = dt.code.lastIndexOf("\n", firstStart - 1) + 1;
  const indent = dt.code.slice(lineStart, firstStart);
  const joined = texts.join(",\n" + indent);
  // Drop any leftover trailing comma right after the old span.
  let after = lastEnd;
  while (after < dt.code.length && (dt.code[after] === " " || dt.code[after] === "\t")) after++;
  if (dt.code[after] === ",") after++;
  return dt.code.slice(0, firstStart) + joined + dt.code.slice(after);
}

/**
 * Split a segment at an absolute composition frame into two abutting segments.
 * For an answer (startSec/endSec) the source in/out point is divided
 * proportionally; for a duration-only card the length is divided. The array
 * element is duplicated and the two copies get the adjusted values.
 */
export function dataSplit(dt: DataTimeline, id: string, atFrame: number): string {
  const el = dt.clips.find((c) => c.id === id);
  if (!el) return dt.code;
  const local = atFrame - el.from;
  if (local <= 0 || local >= el.durationInFrames) return dt.code;

  const elemText = dt.code.slice(el.elementStart, el.elementEnd + 1);
  const rel = (r: { start: number; end: number }) => ({ start: r.start - el.elementStart, end: r.end - el.elementStart });

  let headText: string;
  let tailText: string;
  if (el.startSec != null && el.endSec != null && el.startSecRange && el.endSecRange) {
    const frac = local / el.durationInFrames;
    const splitSec = trimNum(Math.round((el.startSec + frac * (el.endSec - el.startSec)) * 100) / 100);
    const endR = rel(el.endSecRange);
    const startR = rel(el.startSecRange);
    headText = elemText.slice(0, endR.start) + splitSec + elemText.slice(endR.end); // head: endSec → split
    tailText = elemText.slice(0, startR.start) + splitSec + elemText.slice(startR.end); // tail: startSec → split
  } else if (el.durValue != null && el.durRange) {
    const durR = rel(el.durRange);
    const headDur = el.durUnit === "sec" ? local / dt.fps : local;
    const tailDur = el.durValue - headDur;
    headText = elemText.slice(0, durR.start) + trimNum(el.durUnit === "sec" ? Math.round(headDur * 100) / 100 : Math.round(headDur)) + elemText.slice(durR.end);
    tailText = elemText.slice(0, durR.start) + trimNum(el.durUnit === "sec" ? Math.round(tailDur * 100) / 100 : Math.round(tailDur)) + elemText.slice(durR.end);
  } else {
    return dt.code; // nothing splittable
  }

  const lineStart = dt.code.lastIndexOf("\n", el.elementStart - 1) + 1;
  const indent = dt.code.slice(lineStart, el.elementStart);
  const replacement = headText + ",\n" + indent + tailText;
  return dt.code.slice(0, el.elementStart) + replacement + dt.code.slice(el.elementEnd + 1);
}

/** Trim an edge by a composition-frame delta, patching seconds or frame fields. */
export function dataTrim(dt: DataTimeline, id: string, edge: "left" | "right", deltaFrames: number): string {
  const el = dt.clips.find((c) => c.id === id);
  if (!el) return dt.code;
  const deltaSec = deltaFrames / dt.fps;

  // Answer-style (startSec/endSec): trim the source in/out point.
  if (el.startSec != null && el.endSec != null && el.startSecRange && el.endSecRange) {
    if (edge === "left") {
      const next = Math.min(el.endSec - 0.1, Math.max(0, el.startSec + deltaSec));
      return patchRange(dt.code, el.startSecRange, trimNum(next));
    }
    const next = Math.max(el.startSec + 0.1, el.endSec + deltaSec);
    return patchRange(dt.code, el.endSecRange, trimNum(next));
  }

  // Duration-style (dur/durSec): shrink/grow the block. A left-edge drag changes
  // length by the opposite sign of a right-edge drag (there's no source in/out to
  // move — the layout loop re-packs, so only the length matters).
  if (el.durValue != null && el.durRange) {
    const sign = edge === "left" ? -1 : 1;
    const deltaVal = (el.durUnit === "sec" ? deltaSec : deltaFrames) * sign;
    const min = el.durUnit === "sec" ? 0.1 : 1;
    const next = Math.max(min, el.durValue + deltaVal);
    return patchRange(dt.code, el.durRange, trimNum(next));
  }

  return dt.code;
}

// ── Segment model (topic-level editing for computed layouts) ─────────────────
//
// Computed edits (card + answer generated per topic, with crossfades) don't pass
// the strict position gate above, so they render read-only via the runtime
// extractor. But their driving array is a clean list of TOPIC SEGMENTS, each with
// startSec/endSec (or the inS/outS spelling the polished interview edits use).
// Editing at the segment level — delete a topic, reorder topics,
// trim a topic's footage — is both safe (patches the array; the loop re-lays-out)
// and the right granularity for interview editing. Positions come from the
// runtime extractor; this model only supplies the source byte ranges to patch.

export interface Segment {
  id: string;
  index: number;
  elementStart: number;
  elementEnd: number;
  startSec: number;
  startSecRange: { start: number; end: number };
  endSec: number;
  endSecRange: { start: number; end: number };
  label: string;
}

export interface SegmentArray {
  code: string;
  fps: number;
  arrayName: string;
  segments: Segment[];
}

/**
 * Find the driving TOPIC-SEGMENT array literal — the one whose elements carry
 * the answer's footage range, written either as startSec/endSec or as the
 * inS/outS pair the polished interview edits use. No position validation: positions
 * are supplied by the runtime extractor; we only need the editable source ranges.
 */
export function parseSegments(code: string, fps: number): SegmentArray | null {
  if (!code || !code.trim()) return null;
  const constants = buildConstants(code, fps);
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$<>., []*]*)?\s*=\s*\[/g;
  let dm: RegExpExecArray | null;
  let best: SegmentArray | null = null;
  while ((dm = declRe.exec(code)) !== null) {
    const arrOpen = code.indexOf("[", dm.index + dm[0].length - 1);
    if (arrOpen === -1) continue;
    const arrClose = matchBracket(code, arrOpen);
    if (arrClose === -1) continue;
    const els = splitObjectElements(code, arrOpen, arrClose);
    const segments: Segment[] = [];
    for (let idx = 0; idx < els.length; idx++) {
      const el = els[idx];
      const startF = findNumericField(code, el.start, el.end, ["startSec", "start", "inS", "in"], constants);
      const endF = findNumericField(code, el.start, el.end, ["endSec", "end", "outS", "out"], constants);
      if (!startF || !endF) continue;
      const label = findStringField(code, el.start, el.end, ["eyebrow", "topic", "title", "label", "lead", "heading", "index", "name"]) ?? `Topic ${segments.length + 1}`;
      segments.push({
        id: `seg_${segments.length}`,
        index: segments.length,
        elementStart: el.start,
        elementEnd: el.end,
        startSec: startF.value,
        startSecRange: startF.range,
        endSec: endF.value,
        endSecRange: endF.range,
        label,
      });
    }
    if (segments.length >= 2 && (!best || segments.length > best.segments.length)) {
      best = { code, fps: constants.fps || fps, arrayName: dm[1], segments };
    }
  }
  return best;
}

export function segmentDelete(sa: SegmentArray, id: string): string {
  const s = sa.segments.find((x) => x.id === id);
  if (!s) return sa.code;
  return deleteElement(sa.code, s);
}

export function segmentDeleteMany(sa: SegmentArray, ids: string[]): string {
  const idSet = new Set(ids);
  const targets = sa.segments.filter((s) => idSet.has(s.id)).sort((a, b) => b.elementStart - a.elementStart);
  let code = sa.code;
  for (const s of targets) code = deleteElement(code, s);
  return code;
}

export function segmentReorder(sa: SegmentArray, id: string, targetIndex: number): string {
  const ordered = [...sa.segments].sort((a, b) => a.elementStart - b.elementStart);
  const fromIdx = ordered.findIndex((s) => s.id === id);
  if (fromIdx === -1) return sa.code;

  const texts = ordered.map((s) => sa.code.slice(s.elementStart, s.elementEnd + 1));
  const [moved] = texts.splice(fromIdx, 1);
  texts.splice(Math.max(0, Math.min(texts.length, targetIndex)), 0, moved);

  // Write each topic's text into ANOTHER topic's slot, rather than rebuilding
  // the span between the first and last topic. The driving array often
  // interleaves other items (title cards, an end card) between the topics, and
  // rebuilding the span deleted them along with the commas holding the array
  // together. Slot-wise replacement leaves every other element untouched.
  let out = sa.code;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const slot = ordered[i];
    out = out.slice(0, slot.elementStart) + texts[i] + out.slice(slot.elementEnd + 1);
  }
  return out;
}

/** Trim a segment's footage by a composition-frame delta (adjusts startSec/endSec). */
export function segmentTrim(sa: SegmentArray, id: string, edge: "left" | "right", deltaFrames: number): string {
  const s = sa.segments.find((x) => x.id === id);
  if (!s) return sa.code;
  const deltaSec = deltaFrames / sa.fps;
  if (edge === "left") {
    const next = Math.min(s.endSec - 0.1, Math.max(0, s.startSec + deltaSec));
    return patchRange(sa.code, s.startSecRange, trimNum(next));
  }
  const next = Math.max(s.startSec + 0.1, s.endSec + deltaSec);
  return patchRange(sa.code, s.endSecRange, trimNum(next));
}

function trimNum(n: number): string {
  // Keep integers integer; otherwise round seconds to 2 decimals.
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function patchRange(code: string, range: { start: number; end: number }, replacement: string): string {
  return code.slice(0, range.start) + replacement + code.slice(range.end);
}
