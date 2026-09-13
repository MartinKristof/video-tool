/**
 * RUN SF end lockup: dice the Figma SVG into animatable layers.
 *
 * The artwork is `RUN | [apify symbol] apify` as one flat 3840x689 export. This
 * splits it into the four layers Filip timed separately, and explodes the RUN
 * dot-matrix glyphs into their individual dots so they can ignite one by one.
 *
 * Output: public/assets/run-lockup/lockup.json
 */
const fs = require("fs");
const path = require("path");

const SRC = "/Users/filip/Downloads/Group 1321321960.svg";
const OUT = path.join(__dirname, "..", "public", "assets", "run-lockup", "lockup.json");

// Expected shape of the artwork — if Figma re-exports differently we want a loud failure,
// not a silently wrong animation.
const EXPECT = { dots: 246, symbol: 3, wordmark: 5, divider: 1 };

/** Absolute-path bbox for the M/L/H/V/C subset Figma emits. */
function bboxOf(d) {
  const toks = d.match(/[MLHVCZmlhvcz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let x = 0, y = 0, cmd = null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const hit = () => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  const num = (i) => parseFloat(toks[i]);
  for (let i = 0; i < toks.length; i++) {
    if (/[MLHVCZmlhvcz]/.test(toks[i])) { cmd = toks[i]; continue; }
    i--;
    switch (cmd) {
      case "M": case "L": x = num(++i); y = num(++i); hit(); break;
      case "H": x = num(++i); hit(); break;
      case "V": y = num(++i); hit(); break;
      case "C": num(++i); num(++i); num(++i); num(++i); x = num(++i); y = num(++i); hit(); break;
      default: i++; break;
    }
    if (cmd === "M") cmd = "L"; // implicit lineto after moveto
  }
  return [minX, minY, maxX, maxY].map((n) => +n.toFixed(3));
}

/** Split a compound path into its individual `M…Z` subpaths (one dot each). */
function subpaths(d) {
  return d
    .split(/(?=M)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .map((s) => (s.endsWith("Z") || s.endsWith("z") ? s : s + "Z"));
}

const svg = fs.readFileSync(SRC, "utf8");
const head = svg.match(/<svg[^>]*>/)[0];
const width = parseFloat(head.match(/width="([\d.]+)"/)[1]);
const height = parseFloat(head.match(/height="([\d.]+)"/)[1]);

const paths = [];
const re = /<path\b([^>]*?)\/?>/gs;
let m;
while ((m = re.exec(svg)) !== null) {
  const attrs = m[1];
  const d = attrs.match(/d="([^"]*)"/);
  if (!d) continue;
  paths.push({
    d: d[1],
    fill: (attrs.match(/fill="([^"]*)"/) || [])[1] || null,
    stroke: (attrs.match(/stroke="([^"]*)"/) || [])[1] || null,
    strokeWidth: parseFloat((attrs.match(/stroke-width="([\d.]+)"/) || [])[1] || "0") || null,
    fillRule: (attrs.match(/fill-rule="([^"]*)"/) || [])[1] || null,
  });
}

// Layer assignment. The export is stable: 0-8 RUN, 9 divider, 10-12 symbol, 13-17 wordmark.
const layers = { run: [], divider: null, symbol: [], wordmark: [] };
paths.forEach((p, i) => {
  if (p.stroke && !p.fill) {
    layers.divider = { d: p.d, stroke: p.stroke, strokeWidth: p.strokeWidth, bbox: bboxOf(p.d) };
  } else if (i <= 8) {
    for (const sd of subpaths(p.d)) layers.run.push({ d: sd, bbox: bboxOf(sd) });
  } else if (["#246DFF", "#20A34E", "#F86606"].includes(p.fill) && i <= 12) {
    layers.symbol.push({ d: p.d, fill: p.fill, bbox: bboxOf(p.d), fillRule: p.fillRule });
  } else {
    layers.wordmark.push({ d: p.d, fill: p.fill, bbox: bboxOf(p.d), fillRule: p.fillRule });
  }
});

// RUN dots ignite in a left-to-right sweep, so store them in that order.
layers.run.sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
// Wordmark letters rise in reading order.
layers.wordmark.sort((a, b) => a.bbox[0] - b.bbox[0]);

// Group the wordmark's paths into letters: the "i" is a stem plus a separate dot
// sitting at the same x, so merge paths whose x-ranges overlap.
const letters = [];
for (const w of layers.wordmark) {
  const prev = letters[letters.length - 1];
  if (prev && w.bbox[0] < prev.bbox[2]) {
    prev.parts.push(w);
    prev.bbox = [
      Math.min(prev.bbox[0], w.bbox[0]), Math.min(prev.bbox[1], w.bbox[1]),
      Math.max(prev.bbox[2], w.bbox[2]), Math.max(prev.bbox[3], w.bbox[3]),
    ];
  } else {
    letters.push({ parts: [w], bbox: [...w.bbox] });
  }
}

const failures = [];
if (layers.run.length !== EXPECT.dots) failures.push(`RUN has ${layers.run.length} dots, expected ${EXPECT.dots}`);
if (layers.symbol.length !== EXPECT.symbol) failures.push(`symbol has ${layers.symbol.length} paths, expected ${EXPECT.symbol}`);
if (layers.wordmark.length !== EXPECT.wordmark) failures.push(`wordmark has ${layers.wordmark.length} paths, expected ${EXPECT.wordmark}`);
if (!layers.divider) failures.push("no divider (stroke-only path) found");

const runBox = layers.run.reduce((a, d) => [
  Math.min(a[0], d.bbox[0]), Math.min(a[1], d.bbox[1]),
  Math.max(a[2], d.bbox[2]), Math.max(a[3], d.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);

console.log(`source     ${SRC}`);
console.log(`viewBox    0 0 ${width} ${height}`);
console.log(`RUN        ${layers.run.length} dots, bbox [${runBox.map((n) => n.toFixed(1)).join(", ")}]`);
console.log(`divider    ${layers.divider ? `${layers.divider.stroke} @ ${layers.divider.strokeWidth}px, x=${layers.divider.bbox[0]}` : "MISSING"}`);
console.log(`symbol     ${layers.symbol.length} triangles: ${layers.symbol.map((s) => s.fill).join(" ")}`);
console.log(`wordmark   ${layers.wordmark.length} paths -> ${letters.length} letter groups at x ${letters.map((l) => l.bbox[0].toFixed(0)).join(", ")}`);

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
  width, height,
  runBox,
  layers: {
    run: layers.run,
    divider: layers.divider,
    symbol: layers.symbol,
    wordmark: letters.map((l) => ({ bbox: l.bbox, parts: l.parts.map((p) => ({ d: p.d, fill: p.fill, fillRule: p.fillRule })) })),
  },
}));
console.log(`\nOK -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
