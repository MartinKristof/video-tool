import type { AnimationType } from "./types";

export interface AnimationTypeMeta {
  id: AnimationType;
  label: string;
  subtitle: string;
  icon: string;
  color: string;
  colorSoft: string;
  badgeLabel: string;
}

export const ANIMATION_TYPES: AnimationTypeMeta[] = [
  {
    id: "animation",
    label: "Animation",
    subtitle: "Motion graphics & b-roll",
    icon: "bolt",
    color: "var(--cyan)",
    colorSoft: "var(--cyan-soft)",
    badgeLabel: "ANIMATION",
  },
  {
    id: "svg",
    label: "SVG",
    subtitle: "Animate SVG assets",
    icon: "layers",
    color: "var(--amber)",
    colorSoft: "var(--amber-soft)",
    badgeLabel: "SVG",
  },
  {
    id: "video",
    label: "Video Edit",
    subtitle: "Compose & edit video files",
    icon: "movie",
    color: "var(--accent)",
    colorSoft: "var(--accent-soft)",
    badgeLabel: "VIDEO",
  },
  {
    id: "terminal",
    label: "Terminal",
    subtitle: "Record terminal sessions with vhs",
    icon: "code",
    color: "var(--cyan)",
    colorSoft: "var(--cyan-soft)",
    badgeLabel: "TERMINAL",
  },
];

/**
 * Fold the legacy "broll" type into "animation".
 *
 * The two were never actually different: buildSystemPrompt has no branch for
 * either, and BROLL_DARK_PROMPT is appended to BOTH — so "B-Roll · dark,
 * cinematic" and "Animation · generic motion graphics" were two doors into one
 * room, generating from a byte-identical 163,680-character prompt. The labels
 * promised a choice the tool could not deliver.
 *
 * Only the DISPLAY is merged. `broll` is still a valid AnimationType and is
 * still what 123 stored projects say, so nothing is migrated or rewritten —
 * they just appear under Animation now. Normalise at every display and filter
 * boundary; never write the result back to a project.
 */
export function normalizeAnimationType(type: AnimationType): AnimationType {
  return type === "broll" ? "animation" : type;
}

export function getAnimationTypeMeta(type: AnimationType): AnimationTypeMeta {
  const id = normalizeAnimationType(type);
  return ANIMATION_TYPES.find((t) => t.id === id) ?? ANIMATION_TYPES[0];
}
