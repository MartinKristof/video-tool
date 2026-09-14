/**
 * Headless regression suite for the timeline emitter (roadmap 1a + 1b).
 *
 *   npx tsx scripts/test-timeline-emitter.ts
 *
 * Two halves:
 *   1. Synthetic fixtures covering what 1a/1b introduced — trim-attribute
 *      splicing, per-tag trims, trimBefore/trimAfter, source-fps conversion,
 *      split in/out points, and base-vs-free track semantics.
 *   2. Every editable project in data/projects/ round-tripped through each edit
 *      and re-evaluated: the emitted code still compiles, the duration export
 *      agrees with the doc, and — the point of 1a — nothing outside the numeric
 *      timing attributes moved.
 */
import fs from "fs";
import path from "path";
import {
  analyzeEditability, codeFromDoc, trimClipLeft, trimClipRight,
  splitClip, rippleDeleteClip, reorderClip, moveClip, repack,
} from "../lib/editable-timeline";
import { parseTimeline, resolveExprInCode } from "../lib/timeline-parser";
import { parseSegments, segmentDelete, segmentReorder, segmentTrim } from "../lib/data-timeline";
import { evalSceneCode } from "../remotion/DynamicScene";

let pass = 0, fail = 0;
const a = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL: " + m); } };
const head = (t: string) => console.log("\n--- " + t + " ---");


const wrap = (body: string, total = 300, fps = 30) => `import React from "react";

export const fps = ${fps};
export const durationInFrames = ${total};

const Composition: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#161718" }}>
${body}
  </AbsoluteFill>
);

export default Composition;
`;

// ───────────────────────────────────────── 1a ─────────────────────────────────
head("video clip with NO trim gets one spliced in on a left-trim");
{
  const code = wrap(`    <Sequence from={0} durationInFrames={150}>
      <OffthreadVideo src={"/m/a.mp4"} />
    </Sequence>
    <Sequence from={150} durationInFrames={150}>
      <OffthreadVideo src={"/m/b.mp4"} />
    </Sequence>`);
  const { doc } = analyzeEditability(code, 30);
  a(!!doc, "editable");
  a(doc!.clips[0].startFrom === undefined, "no startFrom initially");
  const next = codeFromDoc(trimClipLeft(doc!, doc!.clips[0].id, 25));
  // New code gets Remotion's current spelling; startFrom/endAt are deprecated.
  a(/trimBefore=\{25\}/.test(next), "trimBefore={25} spliced into the media tag");
  a(!/startFrom=/.test(next), "and the deprecated name is not used for new code");
  a(!evalSceneCode(next)?.error, "still evaluates");
  const re = analyzeEditability(next, 30).doc!;
  a(re.clips[0].startFrom === 25, "re-parses with startFrom 25");
  a(re.clips[0].durationInFrames === 125, "clip shortened to 125");
  a(re.clips[1].from === 125, "following clip rippled left by 25");
  a(re.totalDurationInFrames === 275, `total 275 (got ${re.totalDurationInFrames})`);
}

// A clip already written with the deprecated spelling must KEEP it. Splicing the
// modern name in beside an existing `startFrom` would leave one tag carrying one
// of each — and re-spelling the whole file would be a huge diff for a one-clip
// edit. 305 existing projects are written the old way.
head("a clip already using startFrom keeps that spelling, and never mixes families");
{
  // The mixing case: an out-point written the old way, and no in-point yet — so
  // the left-trim below has to SPLICE one next to an existing `endAt`.
  const code = wrap(`    <Sequence from={0} durationInFrames={150}>
      <OffthreadVideo src={"/m/a.mp4"} endAt={200} />
    </Sequence>`);
  const { doc } = analyzeEditability(code, 30);
  a(!!doc, "editable");
  a(doc!.clips[0].endAt === 200, "the deprecated spelling still parses");
  const next = codeFromDoc(trimClipLeft(doc!, doc!.clips[0].id, 25));
  a(/startFrom=\{25\}/.test(next), "the spliced in-point matches the family already on the tag");
  a(!/trimBefore=|trimAfter=/.test(next), "so no tag ends up with one name from each family");
  a(/endAt=\{200\}/.test(next), "and the existing attribute is left alone");
}

head("two <Video> tags in ONE Sequence keep their own trims");
{
  const code = wrap(`    <Sequence from={0} durationInFrames={150}>
      <OffthreadVideo src={"/m/a.mp4"} startFrom={10} endAt={160} />
      <OffthreadVideo src={"/m/b.mp4"} startFrom={900} endAt={1050} />
    </Sequence>`, 150);
  const clips = parseTimeline(code, 30);
  a(clips.length === 2, `parseTimeline finds 2 (${clips.length})`);
  a(clips[0].startFrom === 10 && clips[1].startFrom === 900,
    `each tag keeps its own startFrom (${clips[0].startFrom}, ${clips[1].startFrom})`);
}

head("trimBefore/trimAfter parse exactly like startFrom/endAt");
{
  const oldSpelling = wrap(`    <Sequence from={0} durationInFrames={100}>
      <OffthreadVideo src={"/m/a.mp4"} startFrom={30} endAt={130} />
    </Sequence>`, 100);
  const newSpelling = oldSpelling.replace("startFrom=", "trimBefore=").replace("endAt=", "trimAfter=");
  const o = analyzeEditability(oldSpelling, 30).doc!;
  const n = analyzeEditability(newSpelling, 30).doc!;
  a(!!n, "modern spelling is editable");
  a(n.clips[0].startFrom === o.clips[0].startFrom && n.clips[0].endAt === o.clips[0].endAt,
    "same parsed trim values");
  const trimmed = codeFromDoc(trimClipRight(n, n.clips[0].id, -10));
  a(/trimAfter=\{120\}/.test(trimmed), "patches the modern attribute in place, keeping its spelling");
}

head("source fps ≠ composition fps converts the trim");
{
  // 60fps source in a 30fps comp: 10 comp frames == 20 source frames.
  const code = wrap(`    <Sequence from={0} durationInFrames={100}>
      <OffthreadVideo src={"/m/a.mp4"} startFrom={0} endAt={200} />
    </Sequence>`, 100);
  const { doc } = analyzeEditability(code, 30, { "/m/a.mp4": 60 }, { "/m/a.mp4": 1000 });
  a(doc!.clips[0].nativeFps === 60, "native fps carried from the probe map");
  const next = codeFromDoc(trimClipRight(doc!, doc!.clips[0].id, -10));
  a(/endAt=\{180\}/.test(next), "endAt moved by 20 SOURCE frames for a 10-frame drag");
  // Without a probe entry it falls back 1:1 (documented limitation, not a crash).
  const noProbe = analyzeEditability(code, 30).doc!;
  const n2 = codeFromDoc(trimClipRight(noProbe, noProbe.clips[0].id, -10));
  a(/endAt=\{190\}/.test(n2), "no probe data ⇒ 1:1 fallback");
}

head("split gives the tail its own startFrom");
{
  const code = wrap(`    <Sequence from={0} durationInFrames={100}>
      <OffthreadVideo src={"/m/a.mp4"} startFrom={50} endAt={150} />
    </Sequence>`, 100);
  const { doc } = analyzeEditability(code, 30);
  const next = codeFromDoc(splitClip(doc!, doc!.clips[0].id, 40));
  a(!evalSceneCode(next)?.error, "split evaluates");
  const re = analyzeEditability(next, 30).doc!;
  a(re.clips.length === 2, "two clips");
  a(re.clips[0].startFrom === 50 && re.clips[0].endAt === 90, `head 50..90 (got ${re.clips[0].startFrom}..${re.clips[0].endAt})`);
  a(re.clips[1].startFrom === 90 && re.clips[1].endAt === 150, `tail 90..150 (got ${re.clips[1].startFrom}..${re.clips[1].endAt})`);
  a(re.clips[1].from === 40 && re.clips[1].durationInFrames === 60, "tail positioned at 40 for 60");
}

// ───────────────────────────────────────── 1b ─────────────────────────────────
head("overlay starting on the same frame as a clip is no longer dropped");
{
  const code = wrap(`    <Sequence from={0} durationInFrames={150}>
      <OffthreadVideo src={"/m/a.mp4"} startFrom={0} endAt={150} />
    </Sequence>
    <Sequence from={0} durationInFrames={60}>
      <div style={{ color: "#fff" }}>Caption over the very first frame</div>
    </Sequence>`, 150);
  const clips = parseTimeline(code, 30);
  a(clips.some(c => c.type === "scene"), "parseTimeline keeps the same-frame overlay");
  const { doc } = analyzeEditability(code, 30);
  a(!!doc, "composition is editable");
  a(doc!.clips.length === 2, `2 clips (${doc!.clips.length})`);
  const overlay = doc!.clips.find(c => c.kind === "scene")!;
  a(overlay.track === "free", "overlay is a FREE track clip");
  a(doc!.clips.find(c => c.kind === "video")!.track === "base", "footage is the BASE track");
}

head("a composition with audio is editable, and the audio is a free lane");
{
  const code = wrap(`    <Sequence from={0} durationInFrames={150}>
      <OffthreadVideo src={"/m/a.mp4"} startFrom={0} endAt={150} />
    </Sequence>
    <Sequence from={150} durationInFrames={150}>
      <OffthreadVideo src={"/m/b.mp4"} startFrom={0} endAt={150} />
    </Sequence>
    <Sequence from={20} durationInFrames={260}>
      <Audio src={"/m/music.mp3"} />
    </Sequence>`);
  const { doc, reason } = analyzeEditability(code, 30);
  a(!!doc, `editable (reason was: ${reason})`);
  const audio = doc!.clips.find(c => c.kind === "audio")!;
  a(!!audio && audio.track === "free", "audio clip is on a free track");

  // trimming audio touches nothing else
  const trimmedAudio = codeFromDoc(trimClipRight(doc!, audio.id, -60));
  a(!evalSceneCode(trimmedAudio)?.error, "audio trim evaluates");
  const ta = analyzeEditability(trimmedAudio, 30).doc!;
  a(ta.clips.find(c => c.kind === "audio")!.durationInFrames === 200, "audio shortened to 200");
  a(ta.clips.filter(c => c.kind === "video").every((c, i) => c.from === [0, 150][i]), "footage did NOT move");

  // deleting the audio leaves the footage alone
  const noAudio = codeFromDoc(rippleDeleteClip(doc!, audio.id));
  const na = analyzeEditability(noAudio, 30).doc!;
  a(!/<Audio\b/.test(noAudio), "audio block removed");
  a(na.clips.filter(c => c.kind === "video").every((c, i) => c.from === [0, 150][i]), "footage did NOT jump");
  a(na.totalDurationInFrames === 300, "total unchanged by a free-track delete");

  // deleting BASE footage carries the audio along
  const base0 = doc!.clips.find(c => c.kind === "video" && c.from === 0)!;
  const rippled = codeFromDoc(rippleDeleteClip(doc!, base0.id));
  const rp = analyzeEditability(rippled, 30).doc!;
  const movedAudio = rp.clips.find(c => c.kind === "audio")!;
  a(movedAudio.from === 0, `audio rode along with the base ripple: 20 - 150 clamps to 0 (got ${movedAudio.from})`);
  a(rp.clips.find(c => c.kind === "video")!.from === 0, "remaining footage slid to 0");

  // free clips may overlap and are not re-packed
  const moved = repack(moveClip(doc!, audio.id, 500));
  a(moved.clips.find(c => c.id === audio.id)!.from === 520, "free clip keeps an arbitrary position through repack");
}

head("base-track trim carries the overlay above it");
{
  const code = wrap(`    <Sequence from={0} durationInFrames={150}>
      <OffthreadVideo src={"/m/a.mp4"} startFrom={0} endAt={150} />
    </Sequence>
    <Sequence from={150} durationInFrames={150}>
      <OffthreadVideo src={"/m/b.mp4"} startFrom={0} endAt={150} />
    </Sequence>
    <Sequence from={160} durationInFrames={40}>
      <div>lower third on clip two</div>
    </Sequence>`);
  const { doc } = analyzeEditability(code, 30);
  const first = doc!.clips.find(c => c.from === 0)!;
  const next = analyzeEditability(codeFromDoc(trimClipRight(doc!, first.id, -30)), 30).doc!;
  a(next.clips.find(c => c.kind === "video" && c.durationInFrames === 150)!.from === 120, "second clip rippled to 120");
  a(next.clips.find(c => c.kind === "scene")!.from === 130, `lower third rode along to 130 (got ${next.clips.find(c => c.kind === "scene")!.from})`);
}

console.log("\n════════════ real projects ════════════");

const ROOT = path.join(__dirname, "..", "data", "projects");
const ids = fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, "project.json")));

/** The composition's declared duration, resolving a symbolic expression. */
const declaredTotal = (code: string, fps: number) => {
  const m = /export\s+(?:const|let|var)\s+durationInFrames\s*=\s*([^;]+);/.exec(code);
  return m ? resolveExprInCode(code, m[1], fps) : null;
};
/**
 * Blank every value the emitter is allowed to touch. Whatever remains must be
 * byte-identical — that is the 1a guarantee for explicit-position compositions.
 */
const skeleton = (code: string) => code
  .replace(/\b(from|durationInFrames|startFrom|endAt|trimBefore|trimAfter)=\{\s*-?\d+\s*\}/g, "$1={#}")
  .replace(/(export\s+(?:const|let|var)\s+durationInFrames\s*=\s*)[^;]+/, "$1#");

type ProjectFile = { name?: string; code?: string; settings?: { fps?: number } };

let explicitSeen = 0, implicitSeen = 0;

for (const id of ids) {
  let p: ProjectFile;
  try { p = JSON.parse(fs.readFileSync(path.join(ROOT, id, "project.json"), "utf8")) as ProjectFile; } catch { continue; }
  if (!p.code) continue;
  const fps = p.settings?.fps ?? 30;
  const { doc } = analyzeEditability(p.code, fps);
  if (!doc) continue;

  const implicit = doc.clips.some(c => c.position === "implicit");
  if (implicit) implicitSeen++; else explicitSeen++;
  const tag = `${id.slice(0,8)} "${p.name}"`;
  const baseline = doc.originalCode;
  a(!evalSceneCode(baseline)?.error, `${tag}: baseline evaluates`);

  // Every edit must leave code that still compiles and whose declared duration
  // matches the doc that comes back out of it.
  const check = (label: string, next: string, expectClips: number, expectTotal?: number) => {
    const ev = evalSceneCode(next);
    a(!ev?.error, `${tag}: ${label} evaluates (${ev?.error ?? "ok"})`);
    const re = analyzeEditability(next, fps).doc;
    a(!!re, `${tag}: ${label} stays editable`);
    if (!re) return;
    const reCount = re.clips.filter(c => c.editable !== false).length;
    a(reCount === expectClips, `${tag}: ${label} clip count ${reCount} === ${expectClips}`);
    a(declaredTotal(next, fps) === re.totalDurationInFrames,
      `${tag}: ${label} declared duration ${declaredTotal(next, fps)} === content ${re.totalDurationInFrames}`);
    if (expectTotal != null) {
      a(re.totalDurationInFrames === expectTotal,
        `${tag}: ${label} total ${re.totalDurationInFrames} === ${expectTotal}`);
    }
    return re;
  };

  const base = doc.clips.filter(c => c.track === "base").sort((x, y) => x.from - y.from);
  const first = base[0], last = base[base.length - 1];
  // Media beds are shown but never edited, so they don't count toward clip totals.
  const n = doc.clips.filter(c => c.editable !== false).length;

  // Trims are clamped — a TransitionSeries child can't go below its adjacent
  // transition, and a media clip can't read past its source — so assert the
  // INVARIANT (the emitted code round-trips to exactly the doc the op produced,
  // and a shortening trim never lengthens the timeline) rather than exact
  // arithmetic, which only the synthetic fixtures above can guarantee.
  const tr = trimClipRight(doc, first.id, -10);
  check("trim-right", codeFromDoc(tr), n, tr.totalDurationInFrames);
  a(tr.totalDurationInFrames <= doc.totalDurationInFrames, `${tag}: trim-right never lengthens`);

  const tl = trimClipLeft(doc, last.id, 10);
  check("trim-left", codeFromDoc(tl), n, tl.totalDurationInFrames);
  a(tl.totalDurationInFrames <= doc.totalDurationInFrames, `${tag}: trim-left never lengthens`);

  // Split the LONGEST clip — a 1-frame clip has no interior frame to cut at and
  // is correctly refused.
  const longest = [...base].sort((x, y) => y.durationInFrames - x.durationInFrames)[0];
  if (longest.durationInFrames >= 2) {
    const sp = splitClip(doc, longest.id, longest.from + Math.floor(longest.durationInFrames / 2));
    check("split", codeFromDoc(sp), n + 1, doc.totalDurationInFrames);
  }

  if (n > 1) {
    const deleted = rippleDeleteClip(doc, first.id);
    check("ripple-delete", codeFromDoc(deleted), n - 1, deleted.totalDurationInFrames);
    a(deleted.totalDurationInFrames <= doc.totalDurationInFrames, `${tag}: ripple-delete never lengthens`);
  }
  if (n > 2) {
    // Reorder is rejected outright when it would place a clip against a longer
    // transition, so the doc either re-lays out at the same length or is unchanged.
    const ro = reorderClip(doc, first.id, 2);
    check("reorder", codeFromDoc(ro), n, doc.totalDurationInFrames);
  }

  // Explicit-position compositions additionally guarantee that NOTHING but the
  // numeric timing attributes moved. Implicit ones legitimately rewrite a slot
  // constant and move whole blocks, so that check doesn't apply to them.
  if (!implicit) {
    a(skeleton(codeFromDoc(trimClipRight(doc, first.id, -10))) === skeleton(baseline),
      `${tag}: trim-right changes ONLY numeric timing attributes`);
    if (n > 2) {
      a(skeleton(codeFromDoc(reorderClip(doc, first.id, 2))) === skeleton(baseline),
        `${tag}: reorder changes ONLY numeric timing attributes`);
    }
    const rp = repack(doc);
    a(rp.clips.every(c => doc.clips.find(o => o.id === c.id)?.from === c.from),
      `${tag}: repack is a no-op on positions`);
  }

  if (/<Audio\b/.test(baseline)) {
    const edits = [
      codeFromDoc(trimClipRight(doc, first.id, -10)),
      codeFromDoc(rippleDeleteClip(doc, first.id)),
      codeFromDoc(reorderClip(doc, first.id, 1)),
    ];
    a(edits.every(e => /<Audio\b/.test(e)), `${tag}: <Audio> bed survives every edit`);
  }
}

console.log(`\n(${explicitSeen} explicit-position projects, ${implicitSeen} TransitionSeries)`);

console.log("\n════════════ topic (segment) edits ════════════");

// Interview/tutorial edits are driven by an array of topics. They are edited at
// TOPIC level — delete a topic, reorder topics, trim a topic's footage — by
// patching that array so the composition's own layout loop re-lays it out.
for (const id of ids) {
  let p: ProjectFile & { animationType?: string };
  try { p = JSON.parse(fs.readFileSync(path.join(ROOT, id, "project.json"), "utf8")); } catch { continue; }
  if (!p.code || p.animationType !== "video") continue;
  const fps = p.settings?.fps ?? 30;
  const sa = parseSegments(p.code, fps);
  if (!sa || sa.segments.length < 3) continue;

  const tag = `${id.slice(0,8)} "${p.name}"`;
  const base = evalSceneCode(p.code);
  a(!base?.error, `${tag}: baseline evaluates`);
  const d0 = base?.durationInFrames ?? 0;

  const del = segmentDelete(sa, sa.segments[1].id);
  const dEval = evalSceneCode(del);
  a(!dEval?.error, `${tag}: delete topic evaluates (${dEval?.error ?? "ok"})`);
  a((parseSegments(del, fps)?.segments.length ?? 0) === sa.segments.length - 1, `${tag}: delete removes one topic`);
  a((dEval?.durationInFrames ?? 0) < d0, `${tag}: delete shortens (${dEval?.durationInFrames} < ${d0})`);

  const ro = segmentReorder(sa, sa.segments[0].id, 2);
  const rEval = evalSceneCode(ro);
  a(!rEval?.error, `${tag}: reorder evaluates (${rEval?.error ?? "ok"})`);
  a(rEval?.durationInFrames === d0, `${tag}: reorder keeps duration (${rEval?.durationInFrames} === ${d0})`);

  const tr = segmentTrim(sa, sa.segments[0].id, "right", -Math.round(fps));
  const tEval = evalSceneCode(tr);
  a(!tEval?.error, `${tag}: trim topic evaluates (${tEval?.error ?? "ok"})`);
  a((tEval?.durationInFrames ?? 0) < d0, `${tag}: trim shortens (${tEval?.durationInFrames} < ${d0})`);
}
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) process.exit(1);
