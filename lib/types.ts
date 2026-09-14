import type { EditorDoc } from "./editor-doc";

export type AnimationType = "broll" | "animation" | "svg" | "video" | "terminal";
// Rendering engine for a project. Remotion (React/`useCurrentFrame`) is the
// The rendering engine a project is authored for. Only Remotion now — the
// HyperFrames (HTML + GSAP) authoring path was removed in v0.1.53 after three
// months in which it produced two projects, one of them a test. The field is
// kept rather than dropped so stored projects still parse; a couple of them say
// "hyperframes" and will simply fail to compile as a Remotion scene, which
// reports as a scene error rather than anything worse.
//
// The HyperFrames RENDERER (lib/hyperframes/, lib/hyperframes-queue.ts) lives on
// because /design-export is built on it; nothing authors against it any more.
export type Engine = "remotion";
export type StyleMode = "default" | "kinetic" | "editorial" | "cinematic";
// Video projects only: how per-topic labels are shown when cutting an interview.
// "cards" = full-screen branded card between answers (default); "chips" = small
// corner pill over the footage; "none" = no labels. Absent on legacy → "cards".
export type TopicCardStyle = "cards" | "chips" | "none";
// How scenes hand off to each other. Absent on legacy projects → treated as "cut".
export type TransitionStyle = "cut" | "blend" | "camera";
// "9x8" is a bespoke near-square landscape canvas (2160x1920) used for a
// specific social/explainer deliverable; it only composes with "horizontal".
export type Resolution = "1080p" | "4k" | "9x8";
export type Orientation = "horizontal" | "vertical" | "square";
export type FPS = 24 | 25 | 30 | 50;

export interface ProjectSettings {
  resolution: Resolution;
  orientation: Orientation;
  fps: FPS;
  // Optional exact canvas size in px. When both are set they override the
  // resolution/orientation presets — for bespoke deliverables (e.g. an
  // 832x2496 event LED screen) that no preset can express. Read via
  // getProjectSize(); API-only for now (the New Project modal has no field).
  width?: number;
  height?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SvgFile {
  filename: string;
  content: string;
}

export interface TerminalZoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TerminalZoomEasing = "snap" | "smooth" | "linear";

export interface TerminalZoom {
  id: string;
  startFrame: number;
  endFrame: number;
  rect: TerminalZoomRect;
  // Optional per-zoom timing overrides. Defaults live in
  // remotion/scenes/terminal/TerminalRecording.tsx (RAMP_IN_FRAMES,
  // RAMP_OUT_FRAMES, and "snap" easing).
  rampInFrames?: number;
  rampOutFrames?: number;
  easing?: TerminalZoomEasing;
}

export interface TerminalEndCard {
  title: string;
  subtitle?: string;
  url?: string;
  startFrame?: number;
}

export interface TerminalBanner {
  text: string;
  subtitle?: string;
  startFrame: number;
  endFrame: number;
}

export interface TerminalFreeze {
  id: string;
  atCompFrame: number;
  durationFrames: number;
}

export interface TerminalAnnotations {
  videoDurationFrames: number;
  videoWidth: number;
  videoHeight: number;
  fps: number;
  zooms: TerminalZoom[];
  freezes?: TerminalFreeze[];
  banner?: TerminalBanner;
  endCard?: TerminalEndCard;
}

export interface Project {
  id: string;
  name: string;
  animationType: AnimationType;
  // Which renderer owns `code`. Optional for backward compat — undefined means remotion.
  engine?: Engine;
  settings: ProjectSettings;
  /**
   * The visual editor's document — tracks of items. When present this is the
   * source of truth for the video and the project opens in the editor; when
   * absent the project is code-first and opens in the legacy code editor.
   * Existing projects have no `doc` and are untouched.
   */
  doc?: EditorDoc;
  code: string;
  chatHistory: ChatMessage[];
  initialPrompt: string;
  notionContent?: string;
  scriptWithTimestamps?: string;
  svgContents?: SvgFile[];
  mediaFolder?: string;
  terminalAnnotations?: TerminalAnnotations;
  // Terminal projects only: when true, the AI is told to preserve any user-set
  // `Set Theme {...}` line instead of forcing the Apify default.
  customTheme?: boolean;
  styleMode?: StyleMode;
  // Video projects only — per-topic label style. Undefined → "cards".
  topicCardStyle?: TopicCardStyle;
  // How scenes transition (cut / blend / camera). Undefined → "cut".
  transitionStyle?: TransitionStyle;
  // When true (default for non-terminal types), the AI may add tasteful SFX.
  useSfx?: boolean;
  // Optional cross-type grouping — several projects for one final video.
  collectionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectMeta = Omit<Project, "chatHistory" | "code" | "notionContent" | "scriptWithTimestamps" | "svgContents">;

export interface Collection {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const RESOLUTION_MAP: Record<`${Orientation}-${Resolution}`, { width: number; height: number }> = {
  "horizontal-4k": { width: 3840, height: 2160 },
  "horizontal-1080p": { width: 1920, height: 1080 },
  "vertical-4k": { width: 2160, height: 3840 },
  "vertical-1080p": { width: 1080, height: 1920 },
  "square-4k": { width: 2160, height: 2160 },
  "square-1080p": { width: 1080, height: 1080 },
  // Bespoke 2160x1920 (9:8) — only valid under "horizontal"; other orientations
  // fall back to their standard presets below.
  "horizontal-9x8": { width: 2160, height: 1920 },
  "vertical-9x8": { width: 1920, height: 2160 },
  "square-9x8": { width: 2160, height: 1920 },
};

export function getResolution(orientation: Orientation, resolution: Resolution): { width: number; height: number } {
  return RESOLUTION_MAP[`${orientation}-${resolution}`] ?? RESOLUTION_MAP["horizontal-4k"];
}

// Canvas size for a project: the explicit width/height when both are set,
// otherwise the preset. Every consumer should go through this rather than
// calling getResolution() directly, so bespoke sizes work everywhere.
export function getProjectSize(settings: ProjectSettings): { width: number; height: number } {
  const w = Number(settings.width);
  const h = Number(settings.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: Math.round(w), height: Math.round(h) };
  }
  return getResolution(settings.orientation, settings.resolution);
}
