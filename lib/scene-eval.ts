/**
 * Evaluating a scene module OUTSIDE React.
 *
 * A scene is a TSX module with `export default`, `export const durationInFrames`
 * and `export const fps`. `remotion/DynamicScene.tsx` has always been able to
 * evaluate one, but that file is `"use client"` — so a route handler importing
 * `evalSceneCode` gets the RSC client-reference proxy, not the function.
 *
 * This module holds the part that has nothing to do with React: the sucrase
 * transform, the module shim the generated/branded code is resolved against, and
 * reading a scene's declared length. DynamicScene imports it rather than keeping
 * a second copy, so there is one list of what a scene is allowed to import.
 *
 * Nothing here RENDERS anything. `durationInFrames` and `fps` are module-scope
 * exports, evaluated when the module body runs, so they can be read without ever
 * mounting the component — which is what makes this safe on the server.
 */

import * as React from "react";
import * as RemotionLib from "remotion";
import * as RemotionTransitions from "@remotion/transitions";
import * as RemotionFade from "@remotion/transitions/fade";
import * as RemotionSlide from "@remotion/transitions/slide";
import * as RemotionWipe from "@remotion/transitions/wipe";
import * as RemotionFlip from "@remotion/transitions/flip";
import * as RemotionClockWipe from "@remotion/transitions/clock-wipe";
import * as RemotionIris from "@remotion/transitions/iris";
import * as RemotionAnimationUtils from "@remotion/animation-utils";
import * as RemotionPaths from "@remotion/paths";
import * as RemotionShapes from "@remotion/shapes";
import * as RemotionNoise from "@remotion/noise";
import * as RemotionMotionBlur from "@remotion/motion-blur";
import * as RemotionLayoutUtils from "@remotion/layout-utils";
import { transform } from "sucrase";
import { BRAND, BRAND_FONT_FACE_CSS } from "../remotion/theme";
import * as Motion from "../remotion/motion";
import * as Decor from "../remotion/decor";
import * as Transitions from "../remotion/transitions";

const THEME_MODULE = { BRAND, BRAND_FONT_FACE_CSS };

export const MODULE_MAP: Record<string, unknown> = {
  remotion: RemotionLib,
  react: React,
  "@remotion/transitions": RemotionTransitions,
  "@remotion/transitions/fade": RemotionFade,
  "@remotion/transitions/slide": RemotionSlide,
  "@remotion/transitions/wipe": RemotionWipe,
  "@remotion/transitions/flip": RemotionFlip,
  "@remotion/transitions/clock-wipe": RemotionClockWipe,
  "@remotion/transitions/iris": RemotionIris,
  "@remotion/animation-utils": RemotionAnimationUtils,
  "@remotion/paths": RemotionPaths,
  "@remotion/shapes": RemotionShapes,
  "@remotion/noise": RemotionNoise,
  "@remotion/motion-blur": RemotionMotionBlur,
  "@remotion/layout-utils": RemotionLayoutUtils,
};

// The same module reached by many spellings: a branded scene says "../../theme",
// a generated one says "@/lib/brand", the snippet library says "./theme".
const THEME_PATTERNS = [
  "../remotion/theme", "./theme", "@/remotion/theme", "remotion/theme", "../theme",
  // AI-generated scenes follow the system prompt and import BRAND from
  // "@/lib/brand". Resolve those to the same theme module the snippets use.
  "@/lib/brand", "lib/brand", "../lib/brand", "../../lib/brand",
];
const MOTION_PATTERNS = [
  "../remotion/motion", "./motion", "@/remotion/motion", "remotion/motion", "../motion", "../../motion",
];
const DECOR_PATTERNS = [
  "../remotion/decor", "./decor", "@/remotion/decor", "remotion/decor", "../decor", "../../decor",
];
const TRANSITIONS_PATTERNS = [
  "../remotion/transitions", "./transitions", "@/remotion/transitions", "remotion/transitions",
  "../transitions", "../../transitions",
];

/** The `require` a scene module is evaluated against. */
export function resolveModule(moduleName: string): unknown {
  const mod = MODULE_MAP[moduleName];
  if (mod) return mod;

  const matches = (patterns: string[]) =>
    patterns.some((p) => moduleName.endsWith(p) || moduleName === p);

  if (matches(THEME_PATTERNS)) return THEME_MODULE;
  if (matches(MOTION_PATTERNS)) return Motion;
  if (matches(DECOR_PATTERNS)) return Decor;
  if (matches(TRANSITIONS_PATTERNS)) return Transitions;

  for (const key of Object.keys(MODULE_MAP)) {
    if (moduleName.startsWith(key + "/")) return MODULE_MAP[key];
  }

  // Unknown module — return empty silently, as the preview always has.
  return {};
}

export function looksLikeCode(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.length < 20) return false;
  return /(?:import |export |function |const |=>)/.test(trimmed);
}

/**
 * Run a scene module's body and hand back its exports. The component is NOT
 * rendered — only module scope runs.
 */
export function evalSceneModule(
  code: string,
  req: (name: string) => unknown = resolveModule,
): Record<string, unknown> | null {
  if (!code || !code.trim() || !looksLikeCode(code)) return null;
  const transformed = transform(code, {
    transforms: ["typescript", "jsx", "imports"],
    jsxRuntime: "classic",
    production: true,
  }).code;

  const exports: Record<string, unknown> = {};
  const mod = { exports };
  const fn = new Function("require", "module", "exports", "React", transformed);
  fn(req, mod, exports, React);
  return mod.exports as Record<string, unknown>;
}

export interface SceneMeta {
  durationInFrames: number;
  fps: number;
}

/** Regex fallback for code that won't evaluate — matches a literal only. */
function metaByRegex(code: string): Partial<SceneMeta> {
  const dur = code.match(/export\s+const\s+durationInFrames\s*=\s*(\d+)/);
  const f = code.match(/export\s+const\s+fps\s*=\s*(\d+)/);
  return {
    durationInFrames: dur ? parseInt(dur[1], 10) : undefined,
    fps: f ? parseInt(f[1], 10) : undefined,
  };
}

/**
 * How long a scene runs and at what rate, read from the module itself.
 *
 * Evaluating rather than pattern-matching is the whole point: three library
 * scenes compute their length (`AiChat` from a flag, `PromptBox` from typing +
 * hold seconds, `Years` from two constants), and those constants are exposed as
 * snippet PARAMETERS — so any static table or regex is wrong the moment a value
 * is changed. A regex is kept only as the fallback for code that throws.
 */
export function sceneMeta(code: string, fallbackFps = 30): SceneMeta {
  let evaluated: Record<string, unknown> | null = null;
  try {
    evaluated = evalSceneModule(code);
  } catch {
    evaluated = null;
  }
  const regex = metaByRegex(code);

  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;

  return {
    durationInFrames:
      num(evaluated?.durationInFrames) ?? num(regex.durationInFrames) ?? 250,
    fps: num(evaluated?.fps) ?? num(regex.fps) ?? fallbackFps,
  };
}

/**
 * How many frames a scene occupies on a timeline running at `docFps`.
 *
 * The library mixes 25fps and 30fps scenes and a document can be 24/25/30/50.
 * Inside EditorComposition the embedded scene is driven by the DOCUMENT's fps,
 * so a 25fps scene dropped into a 30fps document needs 20% more frames to play
 * to its end — without this it is cut short.
 */
export function sceneFramesAtFps(meta: SceneMeta, docFps: number): number {
  if (!meta.fps || !Number.isFinite(meta.fps)) return meta.durationInFrames;
  return Math.max(1, Math.round((meta.durationInFrames / meta.fps) * docFps));
}
