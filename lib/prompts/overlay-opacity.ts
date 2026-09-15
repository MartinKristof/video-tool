// Authoritative overlay-opacity rule. Appended LAST in the system prompt (after
// the style preset) so it wins on recency over any style guidance that still
// mentions translucent card fills. Applies to all non-terminal animation types —
// an opaque fill reads correctly both in a standalone render and when the
// animation is exported with a transparent background and overlaid on footage.
//
// It was called BROLL_DARK_PROMPT, which described neither what it does nor how
// widely it is applied, and read like a b-roll style preset that had leaked onto
// svg and video by accident. It hasn't: every type that can be exported with a
// transparent background needs it.

export const OVERLAY_OPACITY_PROMPT = `=== OVERLAY OPACITY (HARD RULE — overrides any earlier styling guidance) ===

These animations are frequently exported with a transparent background and overlaid
on top of existing video. A semi-transparent element looks fine on a dark preview
canvas but turns washed-out / see-through over real footage. So:

- Every element that sits DIRECTLY on the scene backdrop — cards, panels, pills,
  badges, chips, bars, callouts — MUST have a FULLY OPAQUE fill. Use \`COLORS.card\`
  (or another opaque surface), NEVER a low-alpha \`rgba(255,255,255,0.0x)\` and NEVER
  \`COLORS.bg\`.
- A low-alpha \`rgba(...)\` fill is allowed ONLY for an element NESTED INSIDE an opaque
  card (e.g. a skeleton placeholder line, a progress-bar track), where its alpha
  composites over the opaque parent instead of over the video.
- Accent emphasis comes from an OPAQUE surface + an \`orange\` border/text, NOT from a
  translucent tint. \`orangeTint\` (16% alpha) is only valid layered over an opaque surface.
- Never set a static \`opacity < 1\` on a container or card. \`opacity\` is for entrance
  animation only, and every reveal must END at opacity 1.
- Only the \`Background\` component may be transparent — transparent exports strip just
  the backdrop, never a card's own background.

Opaque card recipe:

\`\`\`tsx
{ backgroundColor: COLORS.card, border: \`1px solid \${COLORS.border}\`, borderRadius: 24, boxShadow: "0 24px 64px rgba(0,0,0,0.4)" }
\`\`\`
`;
