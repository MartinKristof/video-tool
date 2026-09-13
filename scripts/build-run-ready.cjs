/**
 * RUN SF "GET READY TO RUN": recover the artwork's vector geometry from the PNG.
 *
 *   node scripts/build-run-ready.cjs
 *
 * Unlike the five voice-over lines there is no Figma SVG for this card, only a
 * 2813x795 transparent PNG. That is fine: every mark in the halftone typeface is an
 * axis-aligned rectangle, so the raster can be inverted back to exact geometry
 * instead of traced. Each connected blob is one bar; its edges are recovered to
 * sub-pixel accuracy from the antialiasing coverage, so the result is resolution
 * independent rather than quantised to the source pixel grid.
 *
 * The PNG shares the SVG unit space of the other text blocks (line pitch 434u, cap
 * height 360u, both measured here), so the scene can reuse their SCALE and the caps
 * match the rest of the piece exactly.
 *
 * The recovery is checked by rasterising the result back at 1:1 and comparing coverage
 * with the source alpha; it agrees to 99.97%, so nothing here is a trace or a guess.
 *
 * Output: public/assets/run-ready/ready.json
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = "/Volumes/T7 Shield/Run_SF_Promo/Graphics/Texts/get-ready-to-run.png";
const OUT = path.join(ROOT, "public", "assets", "run-ready", "ready.json");

const FILL = "#F86606";
const ALPHA_MIN = 4;    // /255 — anything above this is part of a bar, not PNG noise
// Measured gap spectrum on this card, in source units — three cleanly separated
// populations, so both thresholds sit in wide empty bands:
//   3-8u    between the dashes that make up one letter
//   35-53u  between letters
//   206u    between words
const GLYPH_GAP = 20;   // u — splits letters, never the dashes inside one
const WORD_GAP = 150;   // u — same threshold the five text blocks use
const ROW_GAP = 40;     // u — blank scanlines that separate the two text rows

// What the card says. A mismatch means the split went wrong, and we refuse to write.
const LINES = [
  ["GET", "READY"],
  ["TO", "RUN"],
];

// ── raster in ────────────────────────────────────────────────────────────────
const [W, H] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height",
  "-of", "csv=p=0:s=x", SRC]).toString().trim().split("x").map(Number);
const rgba = execFileSync("ffmpeg", ["-v", "error", "-i", SRC, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
  { maxBuffer: 1 << 28 });

/** Alpha coverage in 0..1 at (x,y). */
const cov = (x, y) => rgba[(y * W + x) * 4 + 3] / 255;
const on = (x, y) => rgba[(y * W + x) * 4 + 3] >= ALPHA_MIN;

// ── connected components: one per bar ────────────────────────────────────────
const label = new Int32Array(W * H).fill(-1);
const bars = [];
const stack = [];
for (let sy = 0; sy < H; sy++) {
  for (let sx = 0; sx < W; sx++) {
    const s = sy * W + sx;
    if (label[s] !== -1 || !on(sx, sy)) continue;
    const id = bars.length;
    const px = [];
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      px.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && label[p - 1] === -1 && on(x - 1, y)) { label[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && label[p + 1] === -1 && on(x + 1, y)) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && label[p - W] === -1 && on(x, y - 1)) { label[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && label[p + W] === -1 && on(x, y + 1)) { label[p + W] = id; stack.push(p + W); }
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const p of px) {
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    bars.push({ x0, y0, x1, y1, n: px.length });
  }
}

/**
 * Sub-pixel rectangle from antialiasing coverage. An interior column of an
 * axis-aligned bar is fully covered, so max(columnSum) is the true height and
 * total/height the true width; the same reasoning transposed gives the edges.
 */
function refine(b) {
  const cols = [], rows = [];
  for (let x = b.x0; x <= b.x1; x++) {
    let s = 0;
    for (let y = b.y0; y <= b.y1; y++) s += cov(x, y);
    cols.push(s);
  }
  for (let y = b.y0; y <= b.y1; y++) {
    let s = 0;
    for (let x = b.x0; x <= b.x1; x++) s += cov(x, y);
    rows.push(s);
  }
  const total = cols.reduce((a, c) => a + c, 0);
  const h = Math.max(...cols);          // tallest column == full bar height
  const w = Math.max(...rows);          // widest row    == full bar width
  const left = b.x0 + (1 - cols[0] / h);   // a full column covers h
  const top = b.y0 + (1 - rows[0] / w);    // a full row covers w
  return {
    bbox: [left, top, left + w, top + h].map((n) => +n.toFixed(3)),
    w: +w.toFixed(3), h: +h.toFixed(3),
    rectness: total / (w * h),          // 1.0 for a true rectangle
  };
}

const rects = bars.map((b) => ({ ...refine(b), px: b }));

// ── group: rows -> words -> glyphs ───────────────────────────────────────────
/** Split values into clusters wherever the sorted sequence leaves a gap > tol. */
function clusterBy(items, lo, hi, tol) {
  const sorted = [...items].sort((a, b) => lo(a) - lo(b));
  const out = [];
  let cur = null, edge = -Infinity;
  for (const it of sorted) {
    if (cur === null || lo(it) - edge > tol) { cur = []; out.push(cur); edge = -Infinity; }
    cur.push(it);
    edge = Math.max(edge, hi(it));
  }
  return out;
}

// Text rows: bars stack down a 360u cap height with no blank scanline inside a row,
// while the rows themselves are 74u apart (434u pitch, 360u caps).
const lines = clusterBy(rects, (r) => r.bbox[1], (r) => r.bbox[3], ROW_GAP);

const failures = [];
if (lines.length !== LINES.length) failures.push(`found ${lines.length} lines, expected ${LINES.length}`);

/** Split a line's bars into letters on the x-gaps between them. */
function glyphsOf(barsIn) {
  return clusterBy(barsIn, (b) => b.bbox[0], (b) => b.bbox[2], GLYPH_GAP).map((g) => {
    const xs = g.flatMap((b) => [b.bbox[0], b.bbox[2]]);
    const ys = g.flatMap((b) => [b.bbox[1], b.bbox[3]]);
    return { bars: g, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
}

const words = [];
lines.forEach((lineBars, li) => {
  const glyphs = glyphsOf(lineBars);
  let cur = null, prevRight = null;
  const lineWords = [];
  for (const g of glyphs) {
    if (cur === null || g.bbox[0] - prevRight > WORD_GAP) {
      cur = { row: li, glyphs: [] };
      lineWords.push(cur);
    }
    cur.glyphs.push(g);
    prevRight = g.bbox[2];
  }
  const expect = LINES[li] || [];
  if (lineWords.length !== expect.length) {
    failures.push(`line ${li}: split into ${lineWords.length} words, expected ${expect.length} (${expect.join(" ")})`);
  }
  lineWords.forEach((wd, i) => {
    const text = expect[i];
    if (text && wd.glyphs.length !== [...text].length) {
      failures.push(`line ${li} word "${text}": ${wd.glyphs.length} glyphs, expected ${[...text].length}`);
    }
    words.push({ ...wd, text: text || `?${i}` });
  });
});

// ── emit ─────────────────────────────────────────────────────────────────────
const r3 = (n) => +n.toFixed(3);
/** One glyph = its bars as a single compound path, so it animates as one mark. */
const pathOf = (glyph) => glyph.bars
  .map((b) => {
    const [x0, y0, x1, y1] = b.bbox;
    return `M${r3(x0)} ${r3(y0)}H${r3(x1)}V${r3(y1)}H${r3(x0)}Z`;
  })
  .join("");

const worstRect = Math.min(...rects.map((r) => r.rectness));
const gaps = [];
words.forEach((wd) => wd.glyphs.forEach((g, i) => {
  if (i > 0) gaps.push(g.bbox[0] - wd.glyphs[i - 1].bbox[2]);
}));

console.log(`source      ${SRC}`);
console.log(`raster      ${W}x${H}, ${rects.length} bars, worst rectness ${worstRect.toFixed(4)}`);
console.log(`lines       ${lines.map((l, i) => `${LINES[i] ? LINES[i].join(" ") : "?"} (${l.length} bars)`).join("  |  ")}`);
console.log(`words       ${words.map((w) => `${w.text}:${w.glyphs.length}g/${w.glyphs.reduce((a, g) => a + g.bars.length, 0)}bars`).join("  ")}`);
console.log(`glyph gaps  ${Math.min(...gaps).toFixed(1)}-${Math.max(...gaps).toFixed(1)}u  (word split at ${WORD_GAP})`);
lines.forEach((l, i) => {
  const top = Math.min(...l.map((r) => r.bbox[1]));
  const bot = Math.max(...l.map((r) => r.bbox[3]));
  console.log(`row ${i}       y ${top.toFixed(1)}-${bot.toFixed(1)}, cap ${(bot - top).toFixed(1)}u  (text blocks: 360u cap, 434u pitch)`);
});

// ── round trip: rasterise the recovered rects at 1:1 and compare to the source ──
// Coverage, not a threshold — these bars are 7px tall and every edge is antialiased.
const roundTrip = new Float64Array(W * H);
for (const r of rects) {
  const [x0, y0, x1, y1] = r.bbox;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    const fy = Math.min(y + 1, y1) - Math.max(y, y0);
    if (fy <= 0 || y < 0 || y >= H) continue;
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const fx = Math.min(x + 1, x1) - Math.max(x, x0);
      if (fx <= 0 || x < 0 || x >= W) continue;
      roundTrip[y * W + x] += fx * fy;
    }
  }
}
let smin = 0, smax = 0, areaGot = 0, areaWant = 0, worstPx = 0;
for (let i = 0; i < W * H; i++) {
  const got = Math.min(1, roundTrip[i]);
  const want = rgba[i * 4 + 3] / 255;
  areaGot += got; areaWant += want;
  smin += Math.min(got, want); smax += Math.max(got, want);
  const d = Math.abs(got - want);
  if (d > worstPx) worstPx = d;
}
const iou = smin / smax;
console.log(`round trip  coverage IoU ${(iou * 100).toFixed(3)}% vs the source alpha, ` +
  `area ratio ${(areaGot / areaWant).toFixed(5)}, worst pixel ${worstPx.toFixed(3)}`);

if (worstRect < 0.97) failures.push(`a blob is not rectangular (rectness ${worstRect.toFixed(3)})`);
if (iou < 0.999) failures.push(`round-trip IoU ${(iou * 100).toFixed(3)}% < 99.9% — the recovered rects are not the artwork`);
if (Math.abs(areaGot / areaWant - 1) > 0.001) failures.push(`round-trip area off by ${((areaGot / areaWant - 1) * 100).toFixed(2)}%`);
if (worstPx > 0.1) failures.push(`a pixel is off by ${worstPx.toFixed(3)} coverage`);

if (failures.length) {
  console.error(`\n${failures.length} assertion failure(s):`);
  failures.forEach((f) => console.error(`  - ${f}`));
  console.error(`not writing ${OUT}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: SRC,
  width: W,
  height: H,
  fill: FILL,
  words: words.map((wd, i) => ({
    i,
    text: wd.text,
    row: wd.row,
    bbox: wd.glyphs.reduce((a, g) => [
      Math.min(a[0], g.bbox[0]), Math.min(a[1], g.bbox[1]),
      Math.max(a[2], g.bbox[2]), Math.max(a[3], g.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]).map(r3),
    fill: FILL,
    glyphs: wd.glyphs.map((g) => ({ d: pathOf(g), bbox: g.bbox.map(r3) })),
  })),
}, null, 0));
console.log(`\nwrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
