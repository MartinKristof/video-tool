import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  staticFile,
  Img,
  delayRender,
  continueRender,
} from "remotion";

// ============================================================================
// ActorRiser — a fast "agent working in the background" flash sequence.
//
// An Apify logo box + a status label are centered on screen; the label HARD-CUTS
// through a sequence of lines, accelerating in pace so it feels like a system
// spinning up. Each line is centered as a unit (the icon repositions at each
// cut). Designed to be composited in After Effects as ProRes 4444 with alpha.
// No sound — SFX are added in AE against the cut list this scene prints to the
// console on mount.
// ============================================================================

// ─── EDIT ME — text & timings ───────────────────────────────────────────────
// A non-Remotion teammate can safely edit everything in this block.
//
//   label   : the words shown
//   kind    : "word"   → normal sentence-case (Inter)
//             "status" → normal sentence-case (Inter)   ← the descriptive lines
//             "tool"   → technical monospace (Roboto Mono); hyphens kept intact
//   frames  : how long this line stays on screen (25 frames = 1 second)
//   chevron : show a trailing "›" after the text?
//
export type SegKind = "word" | "tool" | "status";
export interface Segment {
  label: string;
  kind: SegKind;
  frames: number;
  chevron: boolean;
}

export const DEFAULT_SEGMENTS: Segment[] = [
  { label: "Thinking",                                kind: "word",   frames: 7, chevron: false },
  { label: "Call-actor",                              kind: "tool",   frames: 5, chevron: true  },
  { label: "Searching real estate agencies in Miami", kind: "status", frames: 3, chevron: true  },
  { label: "Scraping business listings",              kind: "status", frames: 3, chevron: true  },
  { label: "Extracting emails and phone numbers",     kind: "status", frames: 3, chevron: true  },
  { label: "Enriching social profiles",               kind: "status", frames: 3, chevron: true  },
  { label: "Collecting reviews and ratings",          kind: "status", frames: 3, chevron: true  },
  { label: "Ranking leads by relevance",              kind: "status", frames: 3, chevron: true  },
  { label: "Get-dataset-items",                       kind: "tool",   frames: 3, chevron: true  },
];

// How long to hold (freeze) the final line after the cuts finish.
export const DEFAULT_FREEZE_FRAMES = 13; // ≈ 0.5s at 25fps

// Punchy, steady drumbeat: a strong 7/5 open, then a crisp 3-frame beat per line
// (3 frames reads as a distinct "punch"; 2 frames blurs past). The cuts run
// 7+5+3×7 = 33 frames (0:00:01:08 at 25fps); the 13-frame end freeze brings the
// total to 46 frames (0:00:01:21). Retune the `frames` numbers above and
// DEFAULT_FREEZE_FRAMES to hit your exact After Effects target.
// ─────────────────────────────────────────────────────────────────────────────

export const fps = 25;

// Duration is DERIVED from the config — never hardcode it. Cumulative cut
// offsets are also exported so Root.tsx / tooling can reuse them.
export const cutFrames = (segs: Segment[]): number[] => {
  const out: number[] = [];
  let acc = 0;
  for (const s of segs) {
    out.push(acc);
    acc += s.frames;
  }
  return out;
};
export const computeDuration = (segs: Segment[], freeze = 0): number =>
  segs.reduce((sum, s) => sum + s.frames, 0) + freeze;

export const durationInFrames = computeDuration(DEFAULT_SEGMENTS, DEFAULT_FREEZE_FRAMES);

// ─── palette (inlined so this file is self-contained / copy-paste safe) ───────
const C = {
  bg: "#161718",
  card: "#1d1e1f",
  border: "#3d3f43",
  text: "#f4f4f5",
  textMuted: "#bfc1c5",
  orange: "#F86606",
};

// ─── fonts ────────────────────────────────────────────────────────────────
// Uniquely-named faces so we get TRUE Inter / Roboto Mono in both the browser
// preview and the render — NOT the app's global "Inter" alias (which is
// SemiBold-24pt). See ClaudeTypewriter.tsx for the same pattern.
const FONT_SANS = "'ARInter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const FONT_MONO = "'ARMono', ui-monospace, 'Roboto Mono', monospace";

const FONT_FACE_CSS = `
@font-face {
  font-family: 'ARInter';
  src: url('/fonts/Inter-Variable.woff2') format('woff2');
  font-weight: 100 900; font-style: normal; font-display: block;
}
@font-face {
  font-family: 'ARMono';
  src: url('/fonts/RobotoMono-Variable.woff2') format('woff2');
  font-weight: 100 700; font-style: normal; font-display: block;
}
`;

// Load both faces behind delayRender so the RENDERER waits for them before
// capturing frame 0 (CSS @font-face alone falls back to serif on early frames).
if (typeof document !== "undefined") {
  const w = window as unknown as { __actorriser_fonts?: boolean };
  if (!w.__actorriser_fonts) {
    w.__actorriser_fonts = true;
    try {
      const handle = delayRender("Loading ActorRiser fonts (Inter + Roboto Mono)");
      const faces = [
        new FontFace("ARInter", `url(${staticFile("fonts/Inter-Variable.woff2")})`, {
          style: "normal",
          weight: "100 900",
          display: "block" as FontDisplay,
        }),
        new FontFace("ARMono", `url(${staticFile("fonts/RobotoMono-Variable.woff2")})`, {
          style: "normal",
          weight: "100 700",
          display: "block" as FontDisplay,
        }),
      ];
      Promise.all(faces.map((f) => f.load().then((ff) => (document.fonts as FontFaceSet).add(ff))))
        .catch(() => undefined)
        .finally(() => continueRender(handle));
    } catch {
      // outside a render context — the CSS @font-face above still applies
    }
  }
}

// ─── props ──────────────────────────────────────────────────────────────────
export interface ActorRiserProps {
  apifyLogo?: string; // staticFile() path to the logo mark
  bgColor?: string; // "transparent" (default) for alpha export; or a hex for a solid bg
  fontSize?: number; // label size in 4K design px (see scaleFactor)
  segments?: Segment[];
  freezeFrames?: number; // hold the last line frozen for this many frames at the end
  scaleFactor?: number; // multiplies all sizes — 1 = 4K, 0.5 = 1080p
  reducedMotion?: boolean; // disables the per-swap label pops (clean cuts only)
}

const ActorRiser: React.FC<ActorRiserProps> = ({
  apifyLogo = staticFile("assets/apify/Apify symbol colors.svg"),
  bgColor = "transparent",
  fontSize = 110,
  segments = DEFAULT_SEGMENTS,
  freezeFrames = DEFAULT_FREEZE_FRAMES,
  scaleFactor = 1,
  reducedMotion = false,
}) => {
  const frame = useCurrentFrame();

  // Everything is authored in 4K design px, then scaled. `s()` scales sizes;
  // horizontal + vertical centering is handled by flexbox so it's correct at
  // any resolution.
  const s = (px: number) => px * scaleFactor;

  const FONT = fontSize;
  const BOX = FONT * 2.0; // rounded-square logo tile
  const RADIUS = BOX * 0.22;
  const GAP = FONT * 0.5; // space between box and label
  const LOGO_W = BOX * 0.56; // logo size inside the tile (rest is padding)

  // ── which segment is showing (hard cut via cumulative offsets) ──
  // After the last cut, the last line simply keeps rendering for `freezeFrames`
  // more frames — a natural freeze/hold on the final state.
  const starts = cutFrames(segments);
  const cutsEnd = computeDuration(segments); // frame where cuts finish
  const total = computeDuration(segments, freezeFrames);

  let activeIndex = 0;
  for (let i = 0; i < segments.length; i++) {
    if (frame >= starts[i]) activeIndex = i;
  }
  const active = segments[Math.min(activeIndex, segments.length - 1)];
  const localFrame = frame - starts[Math.min(activeIndex, starts.length - 1)];

  // ── subtle scale pop on the LABEL only: 1.0 → 1.03 → 1.0 over POP_FRAMES ──
  const POP_FRAMES = 2;
  const bump = Math.sin(Math.min(Math.max(localFrame, 0) / POP_FRAMES, 1) * Math.PI); // 0→1→0
  const labelScale = reducedMotion ? 1 : 1 + 0.03 * bump;

  const isMono = active.kind === "tool";

  // ── cut list → console (once), so click SFX can be lined up in AE ──
  React.useEffect(() => {
    const wref = window as unknown as { __actorriser_logged?: boolean };
    if (wref.__actorriser_logged) return;
    wref.__actorriser_logged = true;
    const list = segments.map((seg, i) => `${seg.label}@${starts[i]}`).join(", ");
    console.log(`CUT LIST (frames): ${list} | cuts end @${cutsEnd}, freeze holds to END@${total}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: bgColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <style>{FONT_FACE_CSS}</style>

      {/* Box + label, centered as a unit. Transform-based pops don't affect
          layout, so centering stays stable regardless of the label pop. */}
      <div style={{ display: "inline-flex", alignItems: "center", gap: s(GAP) }}>
        {/* Logo box — no pop, size is fixed. */}
        <div
          style={{
            flexShrink: 0,
            width: s(BOX),
            height: s(BOX),
            borderRadius: s(RADIUS),
            background: C.card,
            border: `${Math.max(1, s(2.5))}px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Img src={apifyLogo} style={{ width: s(LOGO_W), height: "auto" }} />
        </div>

        {/* Label — subtle pop on swap. */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            whiteSpace: "nowrap",
            transform: `scale(${labelScale})`,
            transformOrigin: "center center",
          }}
        >
          <span
            style={{
              fontFamily: isMono ? FONT_MONO : FONT_SANS,
              fontWeight: isMono ? 500 : 600,
              fontSize: s(isMono ? FONT * 0.9 : FONT),
              letterSpacing: isMono ? "-0.01em" : "0.005em",
              color: C.text,
            }}
          >
            {active.label}
          </span>
          {active.chevron && (
            <span
              style={{
                fontFamily: FONT_SANS,
                fontWeight: 500,
                fontSize: s(FONT * 0.95),
                color: C.textMuted,
                marginLeft: s(FONT * 0.32),
              }}
            >
              {"›"}
            </span>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default ActorRiser;
