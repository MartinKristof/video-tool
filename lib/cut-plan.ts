import type { Transcript } from "./transcribe";

export interface CutPlanThresholds {
  /** Drop silences longer than this many seconds. */
  maxGapSeconds: number;
  /** Drop filler words from `fillers` if true. */
  removeFillers: boolean;
  /** Lowercase, punctuation-stripped tokens to drop. Multi-word phrases supported. */
  fillers: string[];
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
  maxGapSeconds: 0.6,
  removeFillers: true,
  fillers: [
    "um",
    "uh",
    "ah",
    "er",
    "hmm",
    "like",
    "you know",
    "sort of",
    "kind of",
    "basically",
    "literally",
    "actually",
    "right",
    "okay",
  ],
  paddingSeconds: 0.05,
};

function normalize(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
}

/** Decide which words to drop as fillers. Handles multi-word phrases (e.g. "you know"). */
function markFillers(transcript: Transcript, fillers: string[]): boolean[] {
  const drop = new Array<boolean>(transcript.words.length).fill(false);
  if (fillers.length === 0) return drop;
  const phrases = fillers.map((f) => normalize(f).split(/\s+/).filter(Boolean));

  for (let i = 0; i < transcript.words.length; i++) {
    for (const phrase of phrases) {
      if (phrase.length === 0) continue;
      let matched = true;
      for (let j = 0; j < phrase.length; j++) {
        const w = transcript.words[i + j];
        if (!w || normalize(w.text) !== phrase[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        for (let j = 0; j < phrase.length; j++) drop[i + j] = true;
        break;
      }
    }
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
    ? markFillers(transcript, thresholds.fillers)
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
