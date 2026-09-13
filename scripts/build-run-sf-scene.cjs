/**
 * RUN SF promo: generate the word-synced scene(s).
 *
 *   node scripts/build-run-sf-scene.cjs           # write the master scene
 *
 * Exposes makeScene() so the export script can build single-line variants.
 * Timings come from data/run-sf/word-timings.json (wav2vec2 forced alignment,
 * refined to the acoustic onset). Regenerate them with scripts/align-run-sf-vo.py.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FPS = 25;
const HOLD_AFTER_LAST_WORD = 10; // frames the finished sentence stays up
const EXIT_FRAMES = 5;           // frames the block takes to clear
const TAIL = 30;                 // frames after the final exit (master only)

const timing = JSON.parse(fs.readFileSync(path.join(ROOT, "data/run-sf/word-timings.json"), "utf8"));
const words = timing.words;
const nBlocks = Math.max(...words.map((w) => w.block)) + 1;

/** One entry per sentence: word onset frames, exit frame, and the source block. */
const CUES = [];
for (let b = 0; b < nBlocks; b++) {
  const ws = words.filter((w) => w.block === b).sort((a, x) => a.wordInBlock - x.wordInBlock);
  CUES.push({
    src: b,
    frames: ws.map((w) => w.frame),
    texts: ws.map((w) => w.text),
    exitStart: Math.round(Math.max(...ws.map((w) => w.end)) * FPS) + HOLD_AFTER_LAST_WORD,
  });
}

const tc = (f) => {
  const s = Math.floor(f / FPS);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f % FPS]
    .map((n) => String(n).padStart(2, "0")).join(":");
};

/**
 * Build the scene source.
 *   onlyBlock  null = all five sentences; N = just sentence N, rebased to frame 0
 *   withAudio  bake the voice-over in (master only — the line exports are silent)
 */
function makeScene({ onlyBlock = null, withAudio = true } = {}) {
  const cues = onlyBlock === null ? CUES : [CUES[onlyBlock]];
  const offset = onlyBlock === null ? 0 : Math.min(...cues[0].frames);
  const lastExit = Math.max(...cues.map((c) => c.exitStart)) + EXIT_FRAMES - offset;
  const durationInFrames = onlyBlock === null ? lastExit + TAIL : lastExit + 2;

  const literal = cues
    .map((c) => `  // ${c.texts.join(" ")}\n  { src: ${c.src}, words: [${c.frames.map((f) => f - offset).join(", ")}], exitStart: ${c.exitStart - offset} },`)
    .join("\n");

  const source = `import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,${withAudio ? " Audio," : ""} staticFile, useCurrentFrame, useVideoConfig,
  spring, interpolate, Easing, delayRender, continueRender,
} from "remotion";
import { SPRINGS } from "../motion";

export const fps = ${FPS};
export const durationInFrames = ${durationInFrames};

// ─── WORD SYNC ───────────────────────────────────────────────────────────────
// \`words[i]\` is the exact frame word i appears on. Derived by wav2vec2 CTC forced
// alignment of the voice-over against the known transcript, then pulled back to the
// true acoustic onset (CTC fires at the evidence peak, which is 0-77ms late depending
// on the first phoneme), then floored to the frame grid — so a word can land up to
// 39ms early and never late. Validated against 5 directly-measured sentence onsets
// to within 5ms. Nudge any number here to retime a single word.
// \`src\` indexes the blocks in assets/run-sf/words.json.
const BLOCKS: { src: number; words: number[]; exitStart: number }[] = [
${literal}
];

// One scale for every block so cap height is identical throughout the piece.
// Widest block is 3478u -> 3200px on the 3840x2160 canvas.
const SCALE = 3200 / 3478;
const INTRA_WORD_STAGGER = 2;   // total frames of ripple across a word, max
const MAX_GLYPH_DELAY = 0.6;    // frames — keeps short words from rippling too slowly
const EXIT_FRAMES = ${EXIT_FRAMES};

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
            transform={\`translate(\${cx} \${cy + dy}) scale(\${s}) translate(\${-cx} \${-cy})\`}
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
        transform: \`translateY(\${-e * 18}px) scale(\${1 - 0.05 * e})\`,
      }}
    >
      <svg
        width={block.width * SCALE}
        height={block.height * SCALE}
        viewBox={\`0 0 \${block.width} \${block.height}\`}
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
${withAudio ? '      <Audio src={staticFile("assets/run-sf/voice.wav")} />\n' : ""}      {data
        ? BLOCKS.map((cue, i) => (
            <TextBlock key={i} block={data.blocks[cue.src]} cue={cue} />
          ))
        : null}
    </AbsoluteFill>
  );
}
`;
  return { source, durationInFrames, offset, cues };
}

if (require.main === module) {
  const { source, durationInFrames } = makeScene({});
  const outPath = path.join(ROOT, "data/run-sf/scene.tsx");
  fs.writeFileSync(outPath, source);
  console.log(`master: ${durationInFrames} frames (${(durationInFrames / FPS).toFixed(2)}s)`);
  CUES.forEach((c, i) => {
    const start = Math.min(...c.frames);
    console.log(`  line ${i + 1}: frames ${start}-${c.exitStart + EXIT_FRAMES} (starts ${tc(start)})  ${c.texts.join(" ")}`);
  });
  console.log(`\nwrote ${outPath}`);
}

module.exports = { makeScene, CUES, FPS, EXIT_FRAMES, tc,
  get scene() { return makeScene({}).source; },
  get durationInFrames() { return makeScene({}).durationInFrames; } };
