// HeroLaunch — a polished launch teaser, authored to be overlaid on footage.
//
// Root background is TRANSPARENT (no Background component, no opaque fill) so the
// alpha render drops straight onto a separate video; every panel is fully opaque.
// A slow connective "camera" push + drift threads the six beats together so they
// never read as six separate clips.
//
// Timeline (25fps, 319f). Beats laid out at absolute script frames; persistent
// surfaces (code panel beats 1-2, failure imagery beats 4-6) are single mounts
// driven by their own sequence-local frame. The chat->failure swipe is a manual
// cross (chat drifts left as the failure stage slides in from the right, 134-150).
import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { FONT_CSS } from "./shared";
import { WindowStage } from "./WindowStage";
import { FailureStage } from "./FailureStage";

export const fps = 25;
// Action runs to frame 389; a ~5s tail (389->514) holds the final frame for editing room.
export const durationInFrames = 514;
const ACTION_END = 389;

export default function HeroLaunch() {
  const frame = useCurrentFrame();

  // Slow connective zoom across the action (no idle drift); holds through the tail.
  const camScale = interpolate(frame, [0, ACTION_END], [1.0, 1.04], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <>
      <style>{FONT_CSS}</style>
      <AbsoluteFill style={{ background: "transparent" }}>
        <AbsoluteFill style={{ transform: `scale(${camScale})` }}>
          {/* Beats 1-5 — terminal in plan mode -> writes code -> API line ->
              the box reforms into the Claude window -> chat msg -> reply slides up */}
          <Sequence from={0} durationInFrames={205} name="WindowStage" layout="none">
            <WindowStage />
          </Sequence>

          {/* Beats 6-9 — signup + card failures, the X->check payoff, then the 5s hold */}
          <Sequence from={175} durationInFrames={339} name="FailureStage" layout="none">
            <FailureStage />
          </Sequence>
        </AbsoluteFill>
      </AbsoluteFill>
    </>
  );
}
