import React, { useEffect, useState } from "react";
import {
  AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig,
  spring, interpolate, Easing, delayRender, continueRender,
} from "remotion";
import { SPRINGS } from "../motion";

export const fps = 25;
export const durationInFrames = 381;

// ─── WORD SYNC ───────────────────────────────────────────────────────────────
// `words[i]` is the exact frame word i appears on. Derived by wav2vec2 CTC forced
// alignment of the voice-over against the known transcript, then pulled back to the
// true acoustic onset (CTC fires at the evidence peak, which is 0-77ms late depending
// on the first phoneme), then floored to the frame grid — so a word can land up to
// 39ms early and never late. Validated against 5 directly-measured sentence onsets
// to within 5ms. Nudge any number here to retime a single word.
// `src` indexes the blocks in assets/run-sf/words.json.
const BLOCKS: { src: number; words: number[]; exitStart: number }[] = [
  // ALL MY LEAD GENERATION RUN THERE
  { src: 0, words: [2, 6, 12, 17, 37, 44], exitStart: 60 },
  // MY PRICE MONITOR RUNS THERE
  { src: 1, words: [77, 82, 91, 101, 110], exitStart: 128 },
  // MY AI AGENTS RUN THERE
  { src: 2, words: [162, 168, 178, 189, 196], exitStart: 213 },
  // MY COMPETITOR RESEARCH RUNS THERE
  { src: 3, words: [231, 234, 247, 260, 269], exitStart: 285 },
  // MY COMPANY'S BRAIN RUNS THERE
  { src: 4, words: [305, 307, 318, 325, 330], exitStart: 346 },
];

// One scale for every block so cap height is identical throughout the piece.
// Widest block is 3478u -> 3200px on the 3840x2160 canvas.
const SCALE = 3200 / 3478;
const INTRA_WORD_STAGGER = 2;   // total frames of ripple across a word, max
const MAX_GLYPH_DELAY = 0.6;    // frames — keeps short words from rippling too slowly
const EXIT_FRAMES = 5;

type Glyph = { d: string; bbox: number[] };
type Word = { i: number; text: string; bbox: number[]; fill: string; glyphs: Glyph[] };
type Block = { file: string; width: number; height: number; words: Word[] };

function useWordData(): { blocks: Block[] } | null {
  const [data, setData] = useState<{ blocks: Block[] } | null>(null);
  const [handle] = useState(() => delayRender("run-sf word geometry"));
  useEffect(() => {
    let live = true;
    fetch(staticFile("assets/run-sf/words.json"))
      .then((r) => r.json())
      .then((j) => { if (live) setData(j); continueRender(handle); })
      .catch(() => continueRender(handle));
    return () => { live = false; };
  }, [handle]);
  return data;
}

/**
 * One word. Every glyph is fully opaque the instant the word lands — the pop is
 * carried by scale + rise, never by a fade, so the arrival reads exactly on the beat.
 * Once settled the word is completely still: no ambient drift, no idle motion.
 */
const WordGroup: React.FC<{ word: Word; start: number; frame: number; vfps: number }> = ({
  word, start, frame, vfps,
}) => {
  const n = word.glyphs.length;
  const step = n > 1 ? Math.min(MAX_GLYPH_DELAY, INTRA_WORD_STAGGER / (n - 1)) : 0;
  return (
    <g>
      {word.glyphs.map((g, gi) => {
        const t = frame - start - gi * step;
        if (t < 0) return null;
        const p = spring({ frame: t, fps: vfps, config: SPRINGS.SNAPPY });
        const cx = (g.bbox[0] + g.bbox[2]) / 2;
        const cy = (g.bbox[1] + g.bbox[3]) / 2;
        const s = 0.86 + 0.14 * p;
        const dy = (1 - p) * 22;
        return (
          <g
            key={gi}
            transform={`translate(${cx} ${cy + dy}) scale(${s}) translate(${-cx} ${-cy})`}
          >
            <path d={g.d} fill={word.fill} />
          </g>
        );
      })}
    </g>
  );
};

const TextBlock: React.FC<{ block: Block; cue: { words: number[]; exitStart: number } }> = ({
  block, cue,
}) => {
  const frame = useCurrentFrame();
  const { fps: vfps } = useVideoConfig();

  const first = Math.min(...cue.words);
  if (frame < first || frame > cue.exitStart + EXIT_FRAMES) return null;

  // Clear at sentence end: a quick settle-out, not a fade to black.
  const e = interpolate(frame, [cue.exitStart, cue.exitStart + EXIT_FRAMES], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic),
  });

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: block.width * SCALE,
        height: block.height * SCALE,
        marginLeft: -(block.width * SCALE) / 2,
        marginTop: -(block.height * SCALE) / 2,
        opacity: 1 - e,
        transform: `translateY(${-e * 18}px) scale(${1 - 0.05 * e})`,
      }}
    >
      <svg
        width={block.width * SCALE}
        height={block.height * SCALE}
        viewBox={`0 0 ${block.width} ${block.height}`}
        style={{ overflow: "visible" }}
      >
        {block.words.map((w, wi) => (
          <WordGroup key={wi} word={w} start={cue.words[wi]} frame={frame} vfps={vfps} />
        ))}
      </svg>
    </div>
  );
};

// No Background component: the piece is transparent by design, for compositing.
export default function RunSfWordSync() {
  const data = useWordData();
  return (
    <AbsoluteFill>
      <Audio src={staticFile("assets/run-sf/voice.wav")} />
      {data
        ? BLOCKS.map((cue, i) => (
            <TextBlock key={i} block={data.blocks[cue.src]} cue={cue} />
          ))
        : null}
    </AbsoluteFill>
  );
}
