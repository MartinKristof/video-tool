import type { Transcript } from "./transcribe";

export interface CutPlanThresholds {
  /** Drop silences longer than this many seconds. */
  maxGapSeconds: number;
  /** Drop filler words from `fillers` if true. */
  removeFillers: boolean;
  /** Lowercase, punctuation-stripped tokens to drop. Multi-word phrases supported. */
  fillers: string[];
  /**
   * Words that are filler only when spoken in isolation. Dropped when a real
   * pause sits on at least one side of them, kept when they are embedded in a
   * phrase — the difference between a verbal tic and "I like it".
   */
  hedges?: string[];
  /** How much silence beside a hedge makes it count as floating. */
  hedgeIsolationSeconds?: number;
  /** Pad each kept range by this many seconds at start + end (clamps to source bounds). */
  paddingSeconds: number;
}

export interface KeepRange {
  /** Seconds into the source media. */
  from: number;
  to: number;
}

export interface RemovedSpan {
  reason: "silence" | "filler";
  from: number;
  to: number;
  text?: string;
}

export interface CutPlan {
  ranges: KeepRange[];
  removed: RemovedSpan[];
  originalDuration: number;
  trimmedDuration: number;
  thresholds: CutPlanThresholds;
}

export const DEFAULT_THRESHOLDS: CutPlanThresholds = {
  // 0.6s cut the breath out of ordinary speech — people pause that long between
  // clauses and for emphasis, and removing every one of them reads as machine-gunned.
  maxGapSeconds: 0.9,
  removeFillers: true,
  // Sounds, not words. These are disfluencies wherever they appear, so they can
  // be dropped without reading the sentence.
  fillers: ["um", "uh", "ah", "er", "err", "erm", "hmm", "mm", "mhm", "uhm"],
  // Real words that are ALSO used as filler. Dropping these on sight is what made
  // Smart trim feel destructive: "I like it" became "I it", "turn right" became
  // "turn". They only come out when they are floating — separated from the speech
  // around them by a real pause — which is what a verbal tic actually sounds like.
  hedges: [
    "like",
    "you know",
    "i mean",
    "sort of",
    "kind of",
    "basically",
    "literally",
    "actually",
    "right",
    "okay",
    "so yeah",
  ],
  /** A hedge counts as floating when there is at least this much silence beside it. */
  hedgeIsolationSeconds: 0.25,
  // 50ms lands the cut on the consonant and clips it; this leaves the word intact.
  paddingSeconds: 0.12,
};

function normalize(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
}

/**
 * Decide which words to drop. Handles multi-word phrases (e.g. "you know").
 *
 * `fillers` are sounds and come out wherever they appear. `hedges` are real
 * words that double as filler, and only come out when they are FLOATING — with
 * at least `isolation` seconds of silence on one side, which is what a verbal
 * tic sounds like. Embedded in a phrase they are load-bearing, and taking them
 * anyway is what turned "I like it" into "I it".
 */
function markFillers(
  transcript: Transcript,
  fillers: string[],
  hedges: string[] = [],
  isolation = 0.25,
): boolean[] {
  const words = transcript.words;
  const drop = new Array<boolean>(words.length).fill(false);
  const toPhrases = (list: string[]) =>
    list.map((f) => normalize(f).split(/\s+/).filter(Boolean)).filter((p) => p.length > 0);
  const always = toPhrases(fillers);
  const conditional = toPhrases(hedges);
  if (always.length === 0 && conditional.length === 0) return drop;

  const matchAt = (i: number, phrase: string[]) => {
    for (let j = 0; j < phrase.length; j++) {
      const w = words[i + j];
      if (!w || normalize(w.text) !== phrase[j]) return false;
    }
    return true;
  };

  /** Silence on either side of the span, in seconds. */
  const floating = (i: number, len: number) => {
    const prev = words[i - 1];
    const next = words[i + len];
    const before = prev ? (words[i].start ?? 0) - (prev.end ?? 0) : Infinity;
    const after = next ? (next.start ?? 0) - (words[i + len - 1].end ?? 0) : Infinity;
    return before >= isolation || after >= isolation;
  };

  for (let i = 0; i < words.length; i++) {
    let hit: string[] | null = null;
    for (const phrase of always) {
      if (matchAt(i, phrase)) { hit = phrase; break; }
    }
    if (!hit) {
      for (const phrase of conditional) {
        if (matchAt(i, phrase) && floating(i, phrase.length)) { hit = phrase; break; }
      }
    }
    if (hit) for (let j = 0; j < hit.length; j++) drop[i + j] = true;
  }
  return drop;
}

export function planCuts(
  transcript: Transcript,
  thresholds: CutPlanThresholds = DEFAULT_THRESHOLDS
): CutPlan {
  // Defensive: cached transcripts written before the flatten() filter landed
  // can still contain words with null/NaN timestamps. Drop them so downstream
  // arithmetic stays numeric.
  const words = transcript.words.filter(
    (w) =>
      typeof w?.start === "number" &&
      typeof w?.end === "number" &&
      Number.isFinite(w.start) &&
      Number.isFinite(w.end) &&
      w.end >= w.start
  );
  if (words.length === 0) {
    return {
      ranges: [],
      removed: [],
      originalDuration: transcript.durationSeconds,
      trimmedDuration: 0,
      thresholds,
    };
  }

  const drop = thresholds.removeFillers
    ? markFillers(
        transcript,
        thresholds.fillers,
        thresholds.hedges ?? [],
        thresholds.hedgeIsolationSeconds ?? 0.25,
      )
    : new Array<boolean>(words.length).fill(false);

  const removed: RemovedSpan[] = [];
  const ranges: KeepRange[] = [];

  let rangeStart: number | null = null;
  let lastKeptEnd: number | null = null;

  const flush = () => {
    if (rangeStart != null && lastKeptEnd != null && lastKeptEnd > rangeStart) {
      ranges.push({ from: rangeStart, to: lastKeptEnd });
    }
    rangeStart = null;
    lastKeptEnd = null;
  };

  let pendingFillerStart: number | null = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (drop[i]) {
      if (pendingFillerStart == null) pendingFillerStart = w.start;
      // Continue a multi-word filler span; emit removed once we exit.
      flush();
      // emit at the end of the run
      if (i + 1 >= words.length || !drop[i + 1]) {
        removed.push({
          reason: "filler",
          from: pendingFillerStart,
          to: w.end,
          text: words.slice(words.findIndex((x) => x.start === pendingFillerStart), i + 1)
            .map((x) => x.text)
            .join(" "),
        });
        pendingFillerStart = null;
      }
      continue;
    }

    if (lastKeptEnd != null) {
      const gap = w.start - lastKeptEnd;
      if (gap > thresholds.maxGapSeconds) {
        flush();
        removed.push({ reason: "silence", from: lastKeptEnd, to: w.start });
      }
    }

    if (rangeStart == null) rangeStart = w.start;
    lastKeptEnd = w.end;
  }
  flush();

  // Apply padding
  const padded: KeepRange[] = [];
  const pad = Math.max(0, thresholds.paddingSeconds);
  const totalDuration = transcript.durationSeconds;
  for (const r of ranges) {
    const from = Math.max(0, r.from - pad);
    const to = Math.min(totalDuration, r.to + pad);
    // Merge with previous if padding caused overlap
    const last = padded[padded.length - 1];
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
    } else {
      padded.push({ from, to });
    }
  }

  const trimmedDuration = padded.reduce((sum, r) => sum + (r.to - r.from), 0);

  return {
    ranges: padded,
    removed,
    originalDuration: transcript.durationSeconds,
    trimmedDuration,
    thresholds,
  };
}

export interface GenerateCodeOptions {
  /** URL/path Remotion's <Video> src — typically a /api/media/[projectId]/... URL. */
  mediaSrc: string;
  fps: number;
}

/** Build a Remotion composition that plays only the kept ranges back-to-back via Series. */
export function generateRemotionCode(plan: CutPlan, opts: GenerateCodeOptions): string {
  const fps = opts.fps;
  const seqs: string[] = [];
  for (const r of plan.ranges) {
    const startFrame = Math.round(r.from * fps);
    const endFrame = Math.round(r.to * fps);
    const duration = Math.max(1, endFrame - startFrame);
    seqs.push(
      `        <Series.Sequence durationInFrames={${duration}}>\n` +
        `          <OffthreadVideo src={${JSON.stringify(opts.mediaSrc)}} trimBefore={${startFrame}} trimAfter={${endFrame}} />\n` +
        `        </Series.Sequence>`
    );
  }
  const totalFrames = Math.max(
    1,
    seqs.length > 0 ? Math.round(plan.trimmedDuration * fps) : 1
  );

  return `import React from "react";
import { AbsoluteFill, Series, OffthreadVideo } from "remotion";

export const fps = ${fps};
export const durationInFrames = ${totalFrames};

// Auto-generated by Smart Trim. Edit ranges by re-running with different thresholds,
// or tweak each <Series.Sequence> manually.
//
// Original duration:  ${plan.originalDuration.toFixed(2)}s
// Trimmed duration:   ${plan.trimmedDuration.toFixed(2)}s  (${(((plan.originalDuration - plan.trimmedDuration) / Math.max(plan.originalDuration, 0.001)) * 100).toFixed(0)}% removed)
// Removed segments:   ${plan.removed.length}

const SmartTrimmed: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Series>
${seqs.join("\n")}
      </Series>
    </AbsoluteFill>
  );
};

export default SmartTrimmed;
`;
}
