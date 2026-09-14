import type { EnrichedMediaFile, TranscriptTruncation } from "../media-analysis";
import type { TopicCardStyle } from "../types";

function topicStyleGuidance(style: TopicCardStyle): string {
  if (style === "chips") {
    return `### Topic labels: corner chips

Label each topic segment with a small persistent PILL/chip in a top corner (brand card bg, orange accent) over the footage — the speaker stays on screen the whole time. Keep the speaker lower-third on the FIRST answer only.`;
  }
  if (style === "none") {
    return `### Topic labels: none

Do NOT add topic labels or chips. Just cut between the answers (keep the speaker lower-third on the first answer). Let the speech carry it.`;
  }
  // default: full-screen cards
  return `### Structure: full-screen topic cards between answers (default)

Between interview answers, put a short **full-screen branded title card** (NOT a small corner chip):
- A \`<Sequence>\` filling the frame on the brand background (\`COLORS.bg\` / the brand background image), with the topic as a large centered headline (e.g. "The impact"), animated in with \`springIn\`. Optionally a small Apify mark. **Hold it ~4–5s (≈100–125 frames at 25fps)** — a real beat that reads as an intentional title card, not a flash. Never under ~3s.
- Then cut to the answer clip.
- Transition the card into the footage (a quick crossfade or wipe) so it feels produced, not a hard slam.
- Keep the speaker **lower-third** on the FIRST answer only.
This gives structure and hides the jump-cuts between passages of the same source.`;
}

function fmtSeconds(s: number): string {
  return s.toFixed(1);
}

function renderSceneCuts(cuts: number[], nativeFps: number): string {
  const MAX = 400;
  const shown = cuts.slice(0, MAX);
  const pairs = shown
    .map((s) => `${s.toFixed(2)}→${Math.round(s * nativeFps)}`)
    .join("  ");
  const suffix =
    cuts.length > shown.length
      ? `  …(+${cuts.length - shown.length} more cuts not shown)`
      : `  (${cuts.length} total)`;
  return `Scene cuts (sec→source-frame @${nativeFps.toFixed(2)}fps): ${pairs}${suffix}`;
}

function renderTranscript(
  segments: { start: number; end: number; text: string }[],
  truncated?: TranscriptTruncation
): string {
  const lines = segments.map((s) => `  [${fmtSeconds(s.start)}–${fmtSeconds(s.end)}] ${s.text}`);
  let out =
    "Transcript (segment start–end in seconds — use these timestamps to locate speech):\n" +
    lines.join("\n");
  if (truncated) {
    out +=
      `\n  [TRANSCRIPT TRUNCATED: showing ${truncated.shown} of ${truncated.total} segments ` +
      `(capped at ${truncated.charCap} chars). If you need a later part, ask the user which ` +
      `region to focus on.]`;
  }
  return out;
}

function renderFile(projectId: string, f: EnrichedMediaFile): string {
  const src = `/api/media/${projectId}/${f.path}`;
  const head = `### ${f.name}  (${f.type}, ${f.sizeFormatted})\nsrc: ${JSON.stringify(src)}`;

  if (f.type === "image") {
    const dims = f.probe ? `${f.probe.width}×${f.probe.height}` : "dimensions unknown";
    return `${head}\n${dims}`;
  }

  const lines: string[] = [head];
  if (f.reframedPath) {
    lines.push(
      `↳ AUTO-REFRAMED version (subject-tracked, already cropped to fill THIS project's ` +
        `frame): use this src instead of the original for this clip → ` +
        `${JSON.stringify(`/api/media/${projectId}/${f.reframedPath}`)}. It has the SAME ` +
        `duration, audio and timeline as the original, so keep the same trimBefore/trimAfter and ` +
        `transcript/scene timestamps — only swap the src. Drop it in full-frame ` +
        `(style width/height 100%, objectFit "cover"); do NOT add your own crop/scale.`
    );
  }
  const p = f.probe;
  if (p) {
    if (f.type === "video") {
      const maxSrcFrame = p.fps > 0 ? Math.round(p.durationSeconds * p.fps) : 0;
      lines.push(
        `duration ${fmtSeconds(p.durationSeconds)}s | native fps ${p.fps.toFixed(2)} | ` +
          `${p.width}×${p.height} | ${p.codec} | audio ${p.hasAudio ? "yes" : "no"}`
      );
      lines.push(`SOURCE frame range: 0 .. ${maxSrcFrame}  (= duration × native fps; max trimAfter)`);
    } else {
      // audio
      lines.push(`duration ${fmtSeconds(p.durationSeconds)}s | ${p.codec}`);
    }
  }

  if (f.analysisPending) {
    lines.push(
      `(Analysis has not been run for this file yet — no transcript or scene-cut data is ` +
        `available. Do NOT invent timestamps or cuts. Tell the user to click "Analyze" first ` +
        `if they want transcript- or cut-aware edits.)`
    );
  }

  if (f.type === "video" && f.sceneCutsSeconds && f.sceneCutsSeconds.length > 0 && p) {
    lines.push(renderSceneCuts(f.sceneCutsSeconds, p.fps));
  }

  if (f.transcriptSegments && f.transcriptSegments.length > 0) {
    lines.push(renderTranscript(f.transcriptSegments, f.transcriptTruncated));
  }

  return lines.join("\n");
}

export function buildVideoEditingPrompt(
  projectId: string,
  mediaFiles: EnrichedMediaFile[],
  compFps: number,
  topicCardStyle: TopicCardStyle = "cards"
): string {
  const fileBlocks =
    mediaFiles.length > 0
      ? mediaFiles.map((f) => renderFile(projectId, f)).join("\n\n")
      : "No media files found in the project folder.";

  return `
## Video Editing Mode

You are now in VIDEO EDITING mode. Instead of creating animations from scratch, you compose and edit existing video/audio/image files using Remotion.

### Available Media Files (with analysis)

The data below is REAL, extracted from the actual files (ffprobe + Whisper transcript + ffmpeg scene detection). Ground every edit in it — use the transcript timestamps and scene cuts to decide where to cut/trim, and never guess at durations or timings you can read here.

${fileBlocks}

### Frame math — READ CAREFULLY (this is the #1 source of wrong edits)

The OUTPUT composition runs at compFps = ${compFps}.

- \`trimBefore\` / \`trimAfter\` trim the SOURCE clip and are in SOURCE frames at THAT FILE's NATIVE fps:
  (Older projects spell these \`startFrom\` / \`endAt\`, which mean exactly the same thing and still work.
  Write \`trimBefore\`/\`trimAfter\` in anything NEW, but do NOT go through existing code renaming them —
  leave a file's existing spelling alone and change only what was actually asked for.)
  \`sourceFrame = round(seconds × nativeFps)\`
- \`<Sequence from>\` / \`durationInFrames\` position a clip in the OUTPUT and are in COMPOSITION frames at compFps:
  \`compFrame = round(seconds × ${compFps})\`

The native fps and compFps usually DIFFER. Never reuse a source frame as a composition frame or vice-versa. **Seconds are the source of truth** — convert from seconds each time. The "→source-frame" numbers next to scene cuts are precomputed for \`trimBefore\`/\`trimAfter\` ONLY; compute \`<Sequence>\` positions yourself from \`seconds × ${compFps}\`.

### Working from editorial notes / comments

The user may provide editorial notes about this footage — pasted into the chat, or attached above as "REFERENCE CONTENT (from Notion)" (often an interview transcript with the decisions marked inline). When such notes exist:
- Treat them as editorial DIRECTION — they decide which moments matter, their order, and the tone.
- **Highlights**: text wrapped like \`[[orange]]…[[/orange]]\` was highlighted that color in Notion. A highlighted passage marks a part the user wants to KEEP/use — match it to the transcript to get its start/end. (The user will say if a color means the opposite.)
- **Comments**: lines beginning \`↳ [comment]\` are Notion comments anchored to the text just above them — they carry instructions like "this is the short", "cut this", or on-screen text to add ("On screen question: What do you think about Apify?"). Follow them.
- Resolve every note against the transcript timestamps and scene cuts above: if it names a quote or topic, find it in the transcript and use that segment's start/end; if it says "the second question" or "after the intro", use the scene cuts.
- If a note is ambiguous or its moment isn't findable in the transcript, say so briefly instead of guessing at a timestamp.
- For "pull the best moments" / "make short clips", make each clip a self-contained \`<Sequence>\` bounded by transcript segments and trimmed with \`trimBefore\`/\`trimAfter\` on the source.

${topicStyleGuidance(topicCardStyle)}

### Never show black frames at cuts (this affects the RENDER, not just preview)

A hard black frame appears at a cut when an \`<OffthreadVideo>\` is asked for a frame OUTSIDE its \`[trimBefore, trimAfter]\` range — it has no footage there, so it renders solid black. The two ways this happens:

1. **TransitionSeries overlap not covered by footage.** \`<TransitionSeries.Sequence durationInFrames={dur + TRANSITION}>\` plays \`dur + TRANSITION\` frames, but if the inner \`<OffthreadVideo trimAfter={...}>\` only spans \`dur\` frames, the overlap frames read PAST \`trimAfter\` → **black at every cut**. FIX: whenever a Sequence is padded by the transition length, extend the clip's \`trimAfter\` (and for a leading transition, pull \`trimBefore\` earlier) by the same number of frames so real footage covers the overlap. A Sequence must never outlive its clip's trim range.
2. **Trim past the file.** Never set \`trimBefore\`/\`trimAfter\` beyond the source file's real duration (you are given each file's duration + max source frame). Reading past the end freezes or blacks out.

Prefer PLAIN back-to-back \`<Sequence from={running} durationInFrames={dur}>\` for hard cuts — they don't overlap, so they can't read past a trim and never black. Keep a solid opaque background \`<AbsoluteFill backgroundColor=…>\` at the root regardless. (The Player preview may still briefly flash while it re-seeks; the render is what matters, and the above keeps it clean.)

### Audio: fade across every cut

Stitching clips (especially from different source files) with \`volume={1}\` hard-cuts the audio, which clicks/pops at each join. Ramp the volume a few frames at each clip's edges instead — e.g. on the \`<OffthreadVideo>\`/\`<Audio>\`:
\`\`\`tsx
volume={(f) => interpolate(f, [0, 3, dur - 3, dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
\`\`\`
(3–4 frame in/out per clip.) This smooths the soundtrack across cuts without any visible change.

### Camera drift / zoom must not move the overlays

If you add a slow camera push/drift/zoom, apply that transform ONLY to the footage/background layer. Text overlays (topic chips, lower-thirds, full-screen cards, end cards) must live in a SEPARATE top-level \`<AbsoluteFill>\` that is NOT inside the camera-transformed element. Otherwise every overlay scales about the frame centre and a corner chip visibly drifts as the camera zooms. If an overlay itself animates scale, set its \`transformOrigin\` to its own anchor (e.g. \`"top left"\` for a top-left chip), never the frame centre.

### How to Reference Media Files

Use the API URL paths shown above. These stream directly from the user's local folder — no upload needed.

\`\`\`tsx
import { Video, OffthreadVideo, Audio, Img, Sequence, staticFile } from "remotion";

// For video clips — use OffthreadVideo for better performance with large files
<OffthreadVideo src="/api/media/${projectId}/clip.mp4" />

// With timing control
<OffthreadVideo
  src="/api/media/${projectId}/interview.mov"
  trimBefore={90}      // start from frame 90 of the SOURCE video (native fps)
  trimAfter={450}          // end at frame 450 of the SOURCE video (native fps)
  volume={0.8}
  style={{ width: "100%", height: "100%" }}
/>

// Audio
<Audio src="/api/media/${projectId}/music.mp3" volume={0.5} />

// Images from the media folder
<Img src="/api/media/${projectId}/photo.jpg" style={{ width: "100%", height: "100%" }} />
\`\`\`

### Key Remotion Video Components

**\`<OffthreadVideo>\`** (preferred for heavy files):
- Renders on a separate thread — won't block the UI
- Props: \`src\`, \`trimBefore\`, \`trimAfter\`, \`volume\`, \`muted\`, \`playbackRate\`, \`style\`
- \`trimBefore\` / \`trimAfter\` are in frames of the SOURCE video (at its native fps)

**\`<Video>\`** (simpler, for lighter clips):
- Same API as \`<OffthreadVideo>\` but renders on main thread

**\`<Audio>\`**:
- Props: \`src\`, \`volume\`, \`trimBefore\`, \`trimAfter\`, \`playbackRate\`

**\`<Sequence>\`** (timeline positioning):
- \`from\`: frame offset where this sequence starts in the composition
- \`durationInFrames\`: how long the sequence lasts
- Children are rendered only during this time window

### Composition Patterns

**Cut edit (clips back to back):**
\`\`\`tsx
const EditedVideo: React.FC = () => {
  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={150}>
        <OffthreadVideo src="/api/media/${projectId}/intro.mp4" />
      </Sequence>
      <Sequence from={150} durationInFrames={300}>
        <OffthreadVideo src="/api/media/${projectId}/main.mp4" trimBefore={60} />
      </Sequence>
      <Sequence from={450} durationInFrames={100}>
        <OffthreadVideo src="/api/media/${projectId}/outro.mp4" />
      </Sequence>
    </AbsoluteFill>
  );
};
\`\`\`

**Overlay text/graphics on video:**
\`\`\`tsx
<AbsoluteFill>
  <OffthreadVideo src="/api/media/${projectId}/footage.mp4" style={{ width: "100%", height: "100%" }} />
  {/* Lower third overlay */}
  <AbsoluteFill style={{ justifyContent: "flex-end", padding: 60 }}>
    <div style={{
      background: "rgba(0,0,0,0.7)",
      padding: "20px 40px",
      borderRadius: 12,
      opacity: titleProgress,
    }}>
      <div style={{ fontSize: 48, fontWeight: 600, color: "#fff" }}>Speaker Name</div>
      <div style={{ fontSize: 28, color: "rgba(255,255,255,0.7)" }}>Title / Role</div>
    </div>
  </AbsoluteFill>
</AbsoluteFill>
\`\`\`

**Picture-in-picture:**
\`\`\`tsx
<AbsoluteFill>
  <OffthreadVideo src="/api/media/${projectId}/main.mp4" style={{ width: "100%", height: "100%" }} />
  <div style={{ position: "absolute", bottom: 40, right: 40, width: 400, height: 225, borderRadius: 12, overflow: "hidden", border: "3px solid white" }}>
    <OffthreadVideo src="/api/media/${projectId}/webcam.mp4" style={{ width: "100%", height: "100%" }} />
  </div>
</AbsoluteFill>
\`\`\`

**Transitions between clips (using TransitionSeries):**
\`\`\`tsx
<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={200}>
    <OffthreadVideo src="/api/media/${projectId}/clip1.mp4" />
  </TransitionSeries.Sequence>
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({ durationInFrames: 15 })}
  />
  <TransitionSeries.Sequence durationInFrames={300}>
    <OffthreadVideo src="/api/media/${projectId}/clip2.mp4" />
  </TransitionSeries.Sequence>
</TransitionSeries>
\`\`\`

### Rules for Video Editing Mode
1. Always use \`OffthreadVideo\` over \`Video\` for video files (better performance with large files)
2. Use \`Sequence\` for timeline positioning — \`from\` is the start frame in the OUTPUT composition (compFps)
3. Use \`trimBefore\`/\`trimAfter\` on the video component to trim the SOURCE clip (native fps) — see Frame math
4. Ground cut points in the provided scene cuts and transcript timestamps; do not invent them
5. Set \`volume\` on video/audio when mixing multiple sources
6. You can combine video editing with all the animation techniques (springs, interpolate, etc.) for overlays, titles, lower thirds
7. The output file structure is the same: export \`fps\`, \`durationInFrames\`, and default component
8. All images from \`staticFile()\` (public/assets/) are still available alongside the media folder files
`;
}
