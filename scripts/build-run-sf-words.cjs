/**
 * RUN SF promo: split the Figma text-block SVGs into per-word path groups.
 *
 * Each <path> in these exports is exactly one glyph (a baked halftone dot cluster).
 * Glyph gaps inside a word measure 36-104u; gaps between words measure 207-215u,
 * so a >150u x-gap is a clean word break. Rows are bucketed off the glyph top edge
 * (line pitch 434u, cap height 360u).
 *
 * Output: public/assets/run-sf/words.json
 */
const fs = require("fs");
const path = require("path");

const SRC = "/Volumes/T7 Shield/Run_SF_Promo/Graphics/Texts/SVG";
const OUT = path.join(__dirname, "..", "public", "assets", "run-sf", "words.json");

const WORD_GAP = 150; // u — comfortably between the 104 max intra-word gap and the 207 min inter-word gap
const ROW_TOL = 60;   // u — line pitch is 434, so this is generous

// Reading order = Figma export order. Text decoded from the glyph shapes and
// confirmed against the voice-over transcript.
const BLOCKS = [
  { file: "text block.svg",   words: ["ALL", "MY", "LEAD", "GENERATION", "RUN", "THERE"] },
  { file: "text block-1.svg", words: ["MY", "PRICE", "MONITOR", "RUNS", "THERE"] },
  { file: "text block-2.svg", words: ["MY", "AI", "AGENTS", "RUN", "THERE"] },
  { file: "text block-3.svg", words: ["MY", "COMPETITOR", "RESEARCH", "RUNS", "THERE"] },
  { file: "text block-4.svg", words: ["MY", "COMPANY'S", "BRAIN", "RUNS", "THERE"] },
];

/** Absolute-path bbox for the M/L/H/V/C/Z subset Figma emits. */
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
    const t = toks[i];
    if (/[MLHVCZmlhvcz]/.test(t)) { cmd = t; continue; }
    i--; // step back onto the number
    switch (cmd) {
      case "M": case "L": x = num(++i); y = num(++i); hit(); break;
      case "H": x = num(++i); hit(); break;
      case "V": y = num(++i); hit(); break;
      case "C": num(++i); num(++i); num(++i); num(++i); x = num(++i); y = num(++i); hit(); break;
      default: i++; break; // unknown command: consume and ignore
    }
    if (cmd === "M") cmd = "L"; // implicit lineto after moveto
  }
  return [minX, minY, maxX, maxY];
}

const out = { generatedAt: new Date().toISOString(), source: SRC, blocks: [] };
let failures = 0;

for (const spec of BLOCKS) {
  const svg = fs.readFileSync(path.join(SRC, spec.file), "utf8");
  const head = svg.match(/<svg[^>]*>/)[0];
  const w = parseFloat(head.match(/width="([\d.]+)"/)[1]);
  const h = parseFloat(head.match(/height="([\d.]+)"/)[1]);

  const glyphs = [];
  const re = /<path\b[^>]*?d="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const d = m[1];
    const bb = bboxOf(d);
    const fill = (m[0].match(/fill="([^"]*)"/) || [, "#F86606"])[1];
    glyphs.push({ d, bb, fill });
  }

  // bucket into rows off the glyph top edge
  const rows = [];
  for (const g of glyphs) {
    let row = rows.find((r) => Math.abs(r.y - g.bb[1]) < ROW_TOL);
    if (!row) { row = { y: g.bb[1], glyphs: [] }; rows.push(row); }
    row.glyphs.push(g);
  }
  rows.sort((a, b) => a.y - b.y);

  // within a row, break a word on a >WORD_GAP horizontal gap
  const words = [];
  for (const [ri, row] of rows.entries()) {
    row.glyphs.sort((a, b) => a.bb[0] - b.bb[0]);
    let cur = null, prevRight = null;
    for (const g of row.glyphs) {
      if (cur === null || g.bb[0] - prevRight > WORD_GAP) {
        cur = { row: ri, glyphs: [] };
        words.push(cur);
      }
      cur.glyphs.push(g);
      prevRight = g.bb[2];
    }
  }

  // verify against the decoded text before emitting anything
  const label = spec.words;
  if (words.length !== label.length) {
    console.error(`FAIL ${spec.file}: split into ${words.length} words, expected ${label.length} (${label.join(" ")})`);
    failures++;
  }
  words.forEach((wd, i) => {
    const expect = label[i] ? [...label[i]].length : null;
    if (expect !== null && wd.glyphs.length !== expect) {
      console.error(`FAIL ${spec.file}: word ${i} "${label[i]}" has ${wd.glyphs.length} glyphs, expected ${expect}`);
      failures++;
    }
  });

  out.blocks.push({
    file: spec.file,
    width: w,
    height: h,
    words: words.map((wd, i) => {
      const xs = wd.glyphs.flatMap((g) => [g.bb[0], g.bb[2]]);
      const ys = wd.glyphs.flatMap((g) => [g.bb[1], g.bb[3]]);
      return {
        i,
        text: label[i] ?? null,
        row: wd.row,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => +n.toFixed(2)),
        fill: wd.glyphs[0].fill,
        glyphs: wd.glyphs.map((g) => ({ d: g.d, bbox: g.bb.map((n) => +n.toFixed(2)) })),
      };
    }),
  });

  console.log(`${spec.file.padEnd(18)} ${w}x${h}  ${words.length} words: ` +
    words.map((wd, i) => `${label[i] ?? "?"}(${wd.glyphs.length})`).join(" "));
}

if (failures) {
  console.error(`\n${failures} assertion failure(s) — not writing ${OUT}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const total = out.blocks.reduce((n, b) => n + b.words.length, 0);
console.log(`\nOK — ${total} words across ${out.blocks.length} blocks -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
