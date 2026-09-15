import React, { useRef, useState, useEffect, useLayoutEffect } from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
  delayRender,
  continueRender,
} from "remotion";

// ============================================================================
// AI chat — a faithful Apify/Claude-style chat on the dark palette. A prompt
// bubble types in (per character), then the answer is revealed either as a
// plain-text typewriter or as uploaded screenshots that scroll in, and it can
// finish on the Apify wordmark. Drop your prompt + answer into the fields.
// ============================================================================

// ===== Editable parameters (the snippet form fills these in) =====
const PROMPT = "Track my competitor's prices on Amazon.";
// ANSWER_MODE: "text" | "images"
const ANSWER_MODE = "text";
const ANSWER_TEXT = "Paste the AI's answer here — plain text is fine. It types out line by line, keeping your paragraph breaks.";
const ANSWER_IMAGES: string[] = [
];
const SHOW_LOGO = true;
// =================================================================

const NO_OUTRO = !SHOW_LOGO;
const IMAGE_MODE = ANSWER_MODE === "images" && ANSWER_IMAGES.length > 0;

export const fps = 25;
// 15s with the Apify wordmark outro; ~11s without.
export const durationInFrames = SHOW_LOGO ? 375 : 275;

// ---- palette ----
const C = {
  bg: "#161718",
  fg: "#F4F4F5",
  link: "#7B9DF9",
  border: "#3E3F43",
  bubble: "#242528",
};

// ---- reference pixel space ----
const REF_W = 1222;
const PAD_L = 43;
const PAD_R = 28;
const INNER = REF_W - PAD_L - PAD_R;
const RESPONSE_TOP = 90;
const DOC_H = 2000; // fallback only — real layout is measured at runtime

// ---- fonts + logos embedded as data URIs (filled by the build script) ----
const INTER_B64 = "__INTER_B64__";
const MONO_B64 = "__MONO_B64__";
const LOGO_B64 = "__LOGO_B64__";
const WORDMARK_B64 = "__WORDMARK_B64__";

const F_BODY = "'AiChatInter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

const FONT_CSS = `
@font-face{font-family:'AiChatInter';src:url(data:font/woff2;base64,${INTER_B64}) format('woff2');font-weight:100 900;font-style:normal;font-display:block;}
@font-face{font-family:'AiChatMono';src:url(data:font/woff2;base64,${MONO_B64}) format('woff2');font-weight:100 700;font-style:normal;font-display:block;}
`;

if (typeof document !== "undefined") {
  const w = window as unknown as { __aichat_fonts?: boolean };
  if (!w.__aichat_fonts) {
    w.__aichat_fonts = true;
    try {
      const handle = delayRender("Loading AI chat fonts");
      const faces = [
        new FontFace("AiChatInter", `url(data:font/woff2;base64,${INTER_B64})`, { weight: "100 900", style: "normal", display: "block" as FontDisplay }),
        new FontFace("AiChatMono", `url(data:font/woff2;base64,${MONO_B64})`, { weight: "100 700", style: "normal", display: "block" as FontDisplay }),
      ];
      Promise.all(faces.map((f) => f.load().then((ff) => (document.fonts as FontFaceSet).add(ff))))
        .catch(() => undefined)
        .finally(() => continueRender(handle));
    } catch {
      // outside a render context — CSS @font-face still applies
    }
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- spike-then-decay reveal easing (fast burst, long ease-out) for text ----
function revVel(u: number): number {
  const RAMP = 0.1;
  const s = u < RAMP ? u / RAMP : 1;
  const ramp = s * s * (3 - 2 * s);
  const decay = Math.exp(-3.6 * Math.max(0, u - RAMP));
  return ramp * (0.09 + 0.91 * decay);
}
const SPIKE_N = 240;
const SPIKE_FULL = (() => {
  let a = 0;
  for (let i = 0; i < SPIKE_N; i++) a += revVel((i + 0.5) / SPIKE_N);
  return a;
})();
function easeSpike(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const m = Math.round(t * SPIKE_N);
  let a = 0;
  for (let i = 0; i < m; i++) a += revVel((i + 0.5) / SPIKE_N);
  return a / SPIKE_FULL;
}

const TEXT_CHARS = [...ANSWER_TEXT];
const TOTAL_CHARS = TEXT_CHARS.length;

const pStyle: React.CSSProperties = { margin: 0, fontSize: 24, lineHeight: "34px", fontFamily: F_BODY, color: C.fg };

// ---- answer renderers ----
const TextAnswer: React.FC<{ charsShown: number }> = ({ charsShown }) => (
  <div data-blk="0" style={{ ...pStyle, whiteSpace: "pre-wrap" }}>
    {TEXT_CHARS.map((ch, i) => (
      <span key={i} style={{ opacity: clamp01((charsShown - i) * 1.4) }}>
        {ch}
      </span>
    ))}
  </div>
);

const ImageAnswer: React.FC = () => (
  <div data-blk="0" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
    {ANSWER_IMAGES.map((src, i) => (
      <img key={i} src={src} alt={`answer ${i + 1}`} style={{ width: INNER, height: "auto", display: "block", borderRadius: 10 }} />
    ))}
  </div>
);

// ---- user bubble ----
const BUBBLE_CHARS = [...PROMPT];
const Bubble: React.FC<{ shown: number; enter?: number }> = ({ shown, enter = 1 }) => {
  const chars = BUBBLE_CHARS.length * shown;
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", width: INNER }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 16, maxWidth: INNER, background: C.bubble, borderRadius: 22, padding: "13px 24px 13px 16px", opacity: enter, transform: `translateY(${(1 - enter) * 14}px)` }}>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#fff", flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <img src={`data:image/svg+xml;base64,${LOGO_B64}`} alt="Apify" style={{ width: 28, height: 28, display: "block" }} />
        </div>
        <span style={{ fontFamily: F_BODY, fontSize: 24, lineHeight: "32px", color: C.fg, whiteSpace: "nowrap" }}>
          {BUBBLE_CHARS.map((ch, i) => (
            <span key={i} style={{ opacity: clamp01((chars - i) * 1.3) }}>
              {ch}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
};

const ENDCARD_LOGO_W = 470;
const EndCard: React.FC<{ scale: number; height: number }> = ({ scale, height }) => (
  <div data-endcard="1" style={{ height, display: "flex", alignItems: "center", justifyContent: "center", width: REF_W }}>
    <img src={`data:image/svg+xml;base64,${WORDMARK_B64}`} alt="Apify" style={{ width: ENDCARD_LOGO_W, height: (ENDCARD_LOGO_W * 141) / 512, transform: `scale(${scale})` }} />
  </div>
);

let BLOCK_LAYOUT: { top: number; height: number }[] | null = null;
let ENDCARD_TOP: number | null = null;

function frontierY(charsShown: number): number {
  if (!BLOCK_LAYOUT || !BLOCK_LAYOUT[0]) return RESPONSE_TOP + (charsShown / Math.max(1, TOTAL_CHARS)) * (DOC_H - RESPONSE_TOP);
  const b = BLOCK_LAYOUT[0];
  return b.top + clamp01(charsShown / Math.max(1, TOTAL_CHARS)) * b.height;
}

const F_TYPE_A = 50;
const F_TYPE_B = 235;
const F_OUT_A = 250;
const F_OUT_B = 300;

const Scene: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const S = width / REF_W;
  const viewRaw = height / S;

  const docRef = useRef<HTMLDivElement>(null);
  const [handle] = useState(() => (BLOCK_LAYOUT ? -1 : delayRender("measure ai chat layout")));
  const [, force] = useState(0);

  useLayoutEffect(() => {
    if (!BLOCK_LAYOUT && docRef.current) {
      const root = docRef.current;
      const els = Array.from(root.querySelectorAll("[data-blk]")) as HTMLElement[];
      BLOCK_LAYOUT = els.map((el) => ({ top: el.offsetTop, height: el.offsetHeight }));
      const ec = root.querySelector("[data-endcard]") as HTMLElement | null;
      ENDCARD_TOP = ec ? ec.offsetTop : root.scrollHeight;
      force((x) => x + 1);
    }
  }, []);
  useEffect(() => {
    if (handle !== -1) continueRender(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bubbleIn = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bubbleType = interpolate(frame, [12, 46], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const typeT = interpolate(frame, [F_TYPE_A, F_TYPE_B], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const charsShown = TOTAL_CHARS * easeSpike(typeT) + 0.001;

  const endcardTop = ENDCARD_TOP ?? DOC_H;
  const target = Math.max(viewRaw - 240, viewRaw * 0.5);
  const respMax = Math.max(0, endcardTop - viewRaw);

  let typeScroll: number;
  if (IMAGE_MODE) {
    const prog = interpolate(frame, [F_TYPE_A, F_TYPE_B], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
    typeScroll = prog * respMax;
  } else {
    typeScroll = Math.min(Math.max(frontierY(charsShown) - target, 0), respMax);
  }

  const outroT = interpolate(frame, [F_OUT_A, F_OUT_B], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const scrollRaw = frame <= F_OUT_A || NO_OUTRO ? typeScroll : lerp(typeScroll, endcardTop, outroT);

  const logoScale = interpolate(spring({ frame: frame - 264, fps, config: { damping: 18, stiffness: 110, mass: 0.9 } }), [0, 1], [0.82, 1]);

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <style>{FONT_CSS}</style>
      <div style={{ position: "absolute", top: 0, left: 0, transformOrigin: "top left", transform: `scale(${S})` }}>
        <div ref={docRef} style={{ position: "relative", width: REF_W, transform: `translateY(${-scrollRaw}px)` }}>
          <div style={{ padding: `20px ${PAD_R}px 0 ${PAD_L}px`, boxSizing: "border-box", width: REF_W }}>
            <Bubble shown={bubbleType} enter={bubbleIn} />
          </div>
          <div style={{ padding: `40px ${PAD_R}px 60px ${PAD_L}px`, boxSizing: "border-box", width: REF_W }}>
            {IMAGE_MODE ? <ImageAnswer /> : <TextAnswer charsShown={charsShown} />}
          </div>
          {!NO_OUTRO && <EndCard scale={logoScale} height={viewRaw} />}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default Scene;
