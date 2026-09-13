/**
 * Verify the delivered line clips — not the source scene, the actual .mov files.
 *
 * For every word: decode the frame before its onset and the onset frame from the
 * exported file, and count orange pixels inside THAT WORD'S bounding box. The box
 * must be empty before and filled on the onset frame. Also confirms the files
 * really carry alpha (corner pixels fully transparent).
 *
 *   node scripts/verify-run-sf-exports.cjs
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const exports_ = JSON.parse(fs.readFileSync(path.join(ROOT, "data/run-sf/exports.json"), "utf8"));
const timing = JSON.parse(fs.readFileSync(path.join(ROOT, "data/run-sf/word-timings.json"), "utf8"));
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "public/assets/run-sf/words.json"), "utf8"));

const W = 3840, H = 2160, SCALE = 3200 / 3478, PAD = 45;
const SW = 960, SH = 540, K = SW / W;

/** Decode the requested frame numbers, downscaled, as RGBA buffers. */
function decodeFrames(file, frames) {
  const sel = frames.map((f) => `eq(n\\,${f})`).join("+");
  const buf = execFileSync("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `select='${sel}',scale=${SW}:${SH}`,
    "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { maxBuffer: 1 << 30 });
  const size = SW * SH * 4;
  const out = new Map();
  frames.forEach((f, i) => out.set(f, buf.subarray(i * size, (i + 1) * size)));
  return out;
}

function countInBox(buf, box) {
  if (!buf || buf.length === 0) return null;
  let n = 0;
  for (let y = box.y0; y < box.y1; y++) {
    let i = (y * SW + box.x0) * 4;
    for (let x = box.x0; x < box.x1; x++, i += 4) {
      if (buf[i] > 150 && buf[i + 1] > 40 && buf[i + 1] < 150 && buf[i + 2] < 80 && buf[i + 3] > 128) n++;
    }
  }
  return n;
}

let bad = 0, total = 0;
for (const [li, ex] of exports_.entries()) {
  if (!fs.existsSync(ex.file)) { console.log(`MISSING ${ex.file}`); bad++; continue; }
  const block = geo.blocks[li];
  const words = timing.words.filter((w) => w.block === li).sort((a, b) => a.wordInBlock - b.wordInBlock);
  const rebased = words.map((w) => w.frame - ex.startFrame);

  const need = [...new Set(rebased.flatMap((f) => [f - 1, f]).filter((f) => f >= 0))].sort((a, b) => a - b);
  const bufs = decodeFrames(ex.file, need);

  const corner = bufs.get(need[need.length - 1]);
  const alphaOk = corner && corner[3] === 0 && corner[(SW * SH - 1) * 4 + 3] === 0;

  console.log(`\nline ${li + 1} — ${path.basename(ex.file)}`);
  console.log(`  place at ${ex.timecode} · ${ex.durationInFrames} frames · alpha: ${alphaOk ? "transparent OK" : "NOT TRANSPARENT"}`);
  if (!alphaOk) bad++;

  const bw = block.width * SCALE, bh = block.height * SCALE;
  const left = W / 2 - bw / 2, top = H / 2 - bh / 2;

  for (const [wi, w] of words.entries()) {
    const word = block.words[wi];
    const f = rebased[wi];
    const box = {
      x0: Math.max(0, Math.round((left + (word.bbox[0] - PAD) * SCALE) * K)),
      y0: Math.max(0, Math.round((top + (word.bbox[1] - PAD) * SCALE) * K)),
      x1: Math.min(SW, Math.round((left + (word.bbox[2] + PAD) * SCALE) * K)),
      y1: Math.min(SH, Math.round((top + (word.bbox[3] + PAD) * SCALE) * K)),
    };
    const before = f - 1 >= 0 ? countInBox(bufs.get(f - 1), box) : null;
    const on = countInBox(bufs.get(f), box);
    const ok = (before === null || before === 0) && on > 200;
    if (!ok) bad++;
    total++;
    console.log(`    ${w.text.padEnd(12)} frame ${String(f).padStart(3)}  before ${String(before ?? "n/a").padStart(5)}  on ${String(on).padStart(5)}   ${ok ? "OK" : "FAIL"}`);
  }
}
console.log(`\n${total - bad}/${total} word onsets correct in the delivered files`);
process.exitCode = bad ? 1 : 0;
