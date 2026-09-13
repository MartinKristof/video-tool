/**
 * Per-word onset verification for the RUN SF scene.
 *
 * Counts orange pixels inside EACH WORD'S OWN bounding box, so a neighbouring word
 * still settling into place cannot contaminate the measurement. For every word the
 * box must be empty on the frames before its onset and filled on the onset frame.
 *
 * Reads the stills written by scripts/check-run-sf-sync.cjs.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/run-sf/check");
const words = JSON.parse(fs.readFileSync(path.join(ROOT, "data/run-sf/word-timings.json"), "utf8")).words;
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "public/assets/run-sf/words.json"), "utf8"));

const W = 3840, H = 2160, STILL = 0.25;
const SCALE = 3200 / 3478;
const PAD = 45; // svg units — covers the 22u entrance rise and ±5px ambient drift

const cache = new Map();
function frameBuf(f) {
  const key = f;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(DIR, `f${String(f).padStart(3, "0")}.png`);
  if (!fs.existsSync(file)) return null;
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1 << 28 });
  cache.set(key, buf);
  return buf;
}

const sw = Math.round(W * STILL);

function countInBox(buf, box) {
  if (!buf) return null;
  let n = 0;
  for (let y = box.y0; y < box.y1; y++) {
    let i = (y * sw + box.x0) * 3;
    for (let x = box.x0; x < box.x1; x++, i += 3) {
      if (buf[i] > 150 && buf[i + 1] > 40 && buf[i + 1] < 150 && buf[i + 2] < 80) n++;
    }
  }
  return n;
}

console.log(`${"word".padEnd(12)}${"frame".padStart(6)}${"box@f-2".padStart(9)}${"box@f-1".padStart(9)}${"box@f".padStart(8)}   verdict`);
let bad = 0;
for (const w of words) {
  const block = geo.blocks[w.block];
  const word = block.words[w.wordInBlock];
  const bw = block.width * SCALE, bh = block.height * SCALE;
  const left = W / 2 - bw / 2, top = H / 2 - bh / 2;
  const box = {
    x0: Math.max(0, Math.round((left + (word.bbox[0] - PAD) * SCALE) * STILL)),
    y0: Math.max(0, Math.round((top + (word.bbox[1] - PAD) * SCALE) * STILL)),
    x1: Math.min(sw, Math.round((left + (word.bbox[2] + PAD) * SCALE) * STILL)),
    y1: Math.min(Math.round(H * STILL), Math.round((top + (word.bbox[3] + PAD) * SCALE) * STILL)),
  };
  const a = countInBox(frameBuf(w.frame - 2), box);
  const b = countInBox(frameBuf(w.frame - 1), box);
  const c = countInBox(frameBuf(w.frame), box);
  const emptyBefore = (a === null || a === 0) && (b === null || b === 0);
  const arrives = c > 200;
  const ok = emptyBefore && arrives;
  if (!ok) bad++;
  console.log(
    `${w.text.padEnd(12)}${String(w.frame).padStart(6)}${String(a ?? "-").padStart(9)}${String(b ?? "-").padStart(9)}${String(c ?? "-").padStart(8)}` +
    `   ${ok ? "OK" : !arrives ? "FAIL: absent on its own frame" : "FAIL: visible early"}`);
}
console.log(`\n${words.length - bad}/${words.length} words: empty box before the onset frame, filled on it`);
process.exit(bad ? 1 : 0);
