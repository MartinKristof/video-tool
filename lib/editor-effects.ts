/**
 * In/out animations for editor items.
 *
 * Deliberately a small, closed set. Most of what a stock "transitions" panel
 * offers is banned in this project and the bans keep regressing, so they are
 * encoded here rather than left to judgement:
 *
 *  - No animated blur on an entrance — elements arrive SHARP.
 *    (lib/prompts/base.ts rule 15)
 *  - No fade from or to black — nothing ramps the whole frame to opacity 0.
 *    (rule 14)
 *  - Never opacity ALONE — every reveal combines 2–3 transforms. (rule 4)
 *  - No slide-only either. (rule 5)
 *  - A typewriter is per-character, never a mask sweep.
 *
 * `presetStyle` is pure so the rules above can be asserted in tests; the easing
 * lives in the renderer, which drives `progress` with the house springs from
 * remotion/motion.ts.
 */

export type AnimationPreset =
  | "none"
  | "rise"
  | "settle"
  | "drift"
  | "pop"
  | "type"
  | "words";

export interface AnimationSpec {
  preset: AnimationPreset;
  durationInFrames: number;
}

export interface PresetInfo {
  id: AnimationPreset;
  label: string;
  hint: string;
  /** Presets that decompose text can't apply to a clip or an image. */
  textOnly?: boolean;
}

export const ANIMATION_PRESETS: PresetInfo[] = [
  { id: "rise", label: "Rise", hint: "Lifts up as it arrives" },
  { id: "settle", label: "Settle", hint: "Eases down from slightly large" },
  { id: "drift", label: "Drift", hint: "Comes in from the side" },
  { id: "pop", label: "Pop", hint: "Springs up with a little rotation" },
  { id: "type", label: "Type", hint: "One character at a time", textOnly: true },
  { id: "words", label: "Word cascade", hint: "Word by word", textOnly: true },
  { id: "none", label: "Cut", hint: "No animation — simply there" },
];

export interface AnimationStyle {
  opacity: number;
  transform: string;
}

const NEUTRAL: AnimationStyle = { opacity: 1, transform: "none" };

/**
 * Style for a preset at `progress`, where 0 is fully animated-out and 1 is
 * settled. `direction` mirrors the travel so an exit leaves the way it came —
 * the idiom the branded scenes already use (`offsetIn + offsetOut`).
 *
 * Travel distances follow the house numbers: 20–60px for a hero, less for
 * secondary elements, scale within 0.9–1.08.
 */
export function presetStyle(
  preset: AnimationPreset,
  progress: number,
  direction: "in" | "out" = "in",
): AnimationStyle {
  const p = Math.max(0, Math.min(1, progress));
  const away = 1 - p;
  // An exit travels the opposite way to an entrance.
  const sign = direction === "in" ? 1 : -1;

  switch (preset) {
    case "rise":
      return {
        opacity: p,
        transform: `translateY(${sign * away * 28}px) scale(${0.98 + p * 0.02})`,
      };
    case "settle":
      return {
        opacity: p,
        transform: `translateY(${-sign * away * 10}px) scale(${1.06 - p * 0.06})`,
      };
    case "drift":
      return {
        opacity: p,
        transform: `translateX(${-sign * away * 24}px) scale(${0.99 + p * 0.01})`,
      };
    case "pop":
      return {
        opacity: p,
        transform: `scale(${0.9 + p * 0.1}) rotate(${-sign * away * 2}deg)`,
      };
    // Per-character and per-word reveals decompose the text itself, so the
    // wrapper stays neutral and the text layer does the work.
    case "type":
    case "words":
    case "none":
    default:
      return NEUTRAL;
  }
}

/** How many characters of `text` are visible at `progress`. */
export function visibleCharacters(text: string, progress: number): number {
  return Math.round(Math.max(0, Math.min(1, progress)) * text.length);
}

/**
 * Per-word progress for a cascade. Each word gets its own ramp, offset by its
 * index, so words arrive in sequence rather than together.
 */
export function wordProgress(index: number, count: number, progress: number): number {
  if (count <= 1) return Math.max(0, Math.min(1, progress));
  const p = Math.max(0, Math.min(1, progress));
  // Overlap the ramps so the cascade reads as one movement, not a queue.
  const span = 1 / count;
  const start = index * span * 0.7;
  const end = start + span + 0.15;
  if (p <= start) return 0;
  if (p >= end) return 1;
  return (p - start) / (end - start);
}

/** Presets available for an item of this type. */
export function presetsFor(itemType: string): PresetInfo[] {
  return ANIMATION_PRESETS.filter((p) => !p.textOnly || itemType === "text" || itemType === "captions");
}

/**
 * A usable frame count for an animation, whatever the document holds.
 *
 * `Math.max(1, x)` is NOT a sufficient guard: `Math.max(1, undefined)` is NaN,
 * and Remotion throws on a NaN spring duration — which takes down the whole
 * preview, not just the animation. Anything missing, zero, negative or not a
 * number falls back instead.
 */
export function animationFrames(spec: AnimationSpec | undefined, fallback = 12): number {
  const n = spec?.durationInFrames;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}
