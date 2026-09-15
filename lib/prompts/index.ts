import { buildBasePrompt } from "./base";
import { OVERLAY_OPACITY_PROMPT } from "./overlay-opacity";
import { COLOR_SYSTEM_PROMPT } from "./colors";
import { APIFY_LAYOUT_PROMPT } from "./apify-layout";
import { buildVideoEditingPrompt } from "./video-editing";
import { getStylePrompt } from "./styles";
import { getTransitionPrompt } from "./transitions";
import { buildTerminalBase } from "./terminal-base";
import { TERMINAL_EDIT_EXAMPLES } from "./terminal-examples";
import { buildSfxPrompt } from "./sfx";
import type { SfxEntry } from "../sfx";
import type { EnrichedMediaFile } from "../media-analysis";
import type { AnimationType, ProjectSettings, StyleMode, TopicCardStyle, TransitionStyle } from "../types";
import { getProjectSize } from "../types";

export function buildSystemPrompt(
  animationType: AnimationType,
  settings: ProjectSettings,
  assetPaths?: string[],
  videoContext?: { projectId: string; mediaFiles: EnrichedMediaFile[]; compFps: number; topicCardStyle?: TopicCardStyle },
  styleMode?: StyleMode,
  customTheme?: boolean,
  useSfx?: boolean,
  sfx?: SfxEntry[],
  transitionStyle?: TransitionStyle,
): string {
  const { width, height } = getProjectSize(settings);

  if (animationType === "terminal") {
    return [buildTerminalBase(width, height, customTheme), TERMINAL_EDIT_EXAMPLES].join("\n\n");
  }

  const base = buildBasePrompt(width, height, settings.fps);

  let prompt = base + "\n\n" + COLOR_SYSTEM_PROMPT + "\n\n" + APIFY_LAYOUT_PROMPT;

  // Append style preset (defaults to "default" if not provided).
  prompt += "\n\n" + getStylePrompt(styleMode);

  // Append the per-project transition style (cut / blend / camera; defaults to
  // "cut"). After style so it can override generic transition guidance.
  prompt += "\n\n" + getTransitionPrompt(transitionStyle);

  // Overlay-opacity rule goes LAST so it overrides any style guidance that still
  // mentions translucent card fills.
  prompt += "\n\n" + OVERLAY_OPACITY_PROMPT;

  if (animationType === "video" && videoContext) {
    prompt += "\n\n" + buildVideoEditingPrompt(videoContext.projectId, videoContext.mediaFiles, videoContext.compFps, videoContext.topicCardStyle ?? "cards");
  }

  const BG_BLOCKLIST = new Set([
    "assets/backgrounds/Backgroudn Green.png",
    "assets/backgrounds/background_blue.png",
    "assets/backgrounds/background.png",
    "assets/backgrounds/Screep White Pink.png",
  ]);
  const filteredAssetPaths = (assetPaths ?? []).filter(
    // SFX are surfaced in their own dedicated section below, not the generic list.
    (p) => !BG_BLOCKLIST.has(p) && !p.startsWith("assets/sfx/")
  );

  if (filteredAssetPaths.length > 0) {
    prompt += `\n\n=== AVAILABLE ASSETS ===\nUse staticFile() from remotion to reference these. Use the EXACT paths below — do not guess filenames.\n\n${filteredAssetPaths.map((p) => `- ${p}`).join("\n")}`;
  }

  if (useSfx && sfx && sfx.length > 0) {
    prompt += "\n\n" + buildSfxPrompt(sfx);
  }

  return prompt;
}

export function buildUserMessage(
  prompt: string,
  code?: string,
  notionContent?: string,
  scriptWithTimestamps?: string,
  animationType?: AnimationType,
  currentTapeDurationMs?: number,
): string {
  const parts: string[] = [];

  if (notionContent) {
    parts.push(`=== REFERENCE CONTENT (from Notion) ===\n${notionContent}\n`);
  }

  if (scriptWithTimestamps) {
    parts.push(`=== VIDEO SCRIPT WITH TIMESTAMPS ===\n${scriptWithTimestamps}\n`);
  }

  if (code) {
    const lang = animationType === "terminal" ? "tape" : "tsx";
    const label = animationType === "terminal" ? "Current .tape script" : "Current scene code";
    parts.push(`${label}:\n\`\`\`${lang}\n${code}\n\`\`\``);
  }

  if (animationType === "terminal" && typeof currentTapeDurationMs === "number" && currentTapeDurationMs > 0) {
    const seconds = (currentTapeDurationMs / 1000).toFixed(2);
    parts.push(
      `Current tape duration: ${seconds}s (server-computed from the script above). ` +
        `If the user asks you to "extend" / "make longer" / "lengthen", the new duration MUST be greater than ${seconds}s. ` +
        `If they ask for a specific length, hit it within 0.5s. Use trailing Sleep to pad — do not delete content the user didn't ask to remove.`,
    );
  }

  parts.push(prompt);

  return parts.join("\n\n");
}
