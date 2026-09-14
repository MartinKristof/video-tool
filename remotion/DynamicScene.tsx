"use client";

import React, { useMemo } from "react";
import * as RemotionLib from "remotion";
import { SvgFramesProvider, type SvgFrameSlot } from "./motion";
import type { MediaCapture } from "@/lib/timeline-extract";
// The transform, the module shim and "what is a scene allowed to import" live
// in a server-safe module so route handlers can read a scene's length without
// importing this "use client" file. One list, not two.
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
import * as Motion from "./motion";
import * as Decor from "./decor";
import * as Transitions from "./transitions";
import { evalSceneModule, looksLikeCode, resolveModule, type SceneModules } from "../lib/scene-eval";

// scene-eval deliberately resolves all of this to inert stubs: importing
// `remotion` (or remotion/motion) needs React.createContext, which Next refuses
// inside a server module — and reading a scene's declared LENGTH never touches
// any of it. Here we actually render, so the real modules go in.
const PACKAGES: Record<string, unknown> = {
  remotion: RemotionLib,
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
const MODULES: SceneModules = {
  motion: Motion, decor: Decor, transitions: Transitions, packages: PACKAGES,
};
const resolveWithLocals = (name: string) => resolveModule(name, MODULES);

const { AbsoluteFill } = RemotionLib;

/**
 * Build a remotion module whose media leaves (OffthreadVideo/Video/Audio/Img)
 * report the sequence they render inside + their src/trim, without changing what
 * they render. Used only by the hidden timeline extractor (not the live preview),
 * so recording during render is acceptable — callers dedupe.
 */
function makeInstrumentedRemotion(onMedia: (m: MediaCapture) => void): typeof RemotionLib {
  const Internals = RemotionLib.Internals;
  const wrap = (Comp: React.ComponentType<Record<string, unknown>>, kind: MediaCapture["kind"]) => {
    const Wrapped: React.FC<Record<string, unknown>> = (props) => {
      const seq = React.useContext(Internals.SequenceContext) as { id?: string } | null;
      onMedia({
        enclosingId: seq?.id ?? null,
        kind,
        src: props.src as string | undefined,
        startFrom: (props.startFrom ?? props.trimBefore) as number | undefined,
        endAt: (props.endAt ?? props.trimAfter) as number | undefined,
      });
      return React.createElement(Comp, props);
    };
    return Wrapped;
  };
  const C = (x: unknown) => x as React.ComponentType<Record<string, unknown>>;
  return {
    ...RemotionLib,
    OffthreadVideo: wrap(C(RemotionLib.OffthreadVideo), "video"),
    Video: wrap(C(RemotionLib.Video), "video"),
    Audio: wrap(C(RemotionLib.Audio), "audio"),
    Img: wrap(C(RemotionLib.Img), "image"),
  } as unknown as typeof RemotionLib;
}

export interface EvalResult {
  component: React.ComponentType<Record<string, unknown>>;
  durationInFrames: number;
  fps: number;
  error?: string;
}

function makeErrorComponent(msg: string): React.ComponentType<Record<string, unknown>> {
  const ErrorComponent: React.FC<Record<string, unknown>> = () =>
    React.createElement(
      AbsoluteFill,
      {
        style: {
          backgroundColor: "#040D12",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 80,
          fontFamily: "sans-serif",
        },
      },
      React.createElement(
        "div",
        { style: { textAlign: "center", maxWidth: "80%" } },
        React.createElement("div", { style: { color: "#f87171", fontSize: 48, marginBottom: 20 } }, "Scene Error"),
        React.createElement("div", { style: { color: "#93B1A6", fontSize: 28, wordBreak: "break-word" } }, msg)
      )
    );
  return ErrorComponent;
}

export function evalSceneCode(
  code: string,
  opts?: { onMedia?: (m: MediaCapture) => void },
): EvalResult | null {
  if (!code || !code.trim() || !looksLikeCode(code)) return null;

  try {
    // The extractor passes onMedia to instrument media leaves; the live preview
    // does not, so it uses the real remotion module untouched.
    const instrumented = opts?.onMedia ? makeInstrumentedRemotion(opts.onMedia) : null;
    const req = instrumented
      ? (name: string) => (name === "remotion" ? instrumented : resolveWithLocals(name))
      : resolveWithLocals;

    const result = evalSceneModule(code, req);
    if (!result) return null;

    // Find component
    let component: React.ComponentType<Record<string, unknown>> | null = null;
    if (result.default && typeof result.default === "function") {
      component = result.default as React.ComponentType<Record<string, unknown>>;
    } else {
      for (const key of Object.keys(result)) {
        if (typeof result[key] === "function" && key !== "default") {
          component = result[key] as React.ComponentType<Record<string, unknown>>;
          break;
        }
      }
    }

    if (!component) {
      // No component found — error shown in preview UI
      return {
        component: makeErrorComponent("No component found — make sure the code has a default export"),
        durationInFrames: 250,
        fps: 25,
        error: "No component export found",
      };
    }

    // Wrap in a safe component that catches render errors
    const Inner = component;
    const SafeComponent: React.FC<Record<string, unknown>> = () => {
      try {
        return React.createElement(Inner);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Render error";
        return React.createElement(makeErrorComponent(msg));
      }
    };

    const durationInFrames =
      typeof result.durationInFrames === "number" ? result.durationInFrames : 250;
    const fps = typeof result.fps === "number" ? result.fps : 25;

    return { component: SafeComponent, durationInFrames, fps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown eval error";
    // Silenced — errors are shown in the preview UI via makeErrorComponent
    return {
      component: makeErrorComponent(msg),
      durationInFrames: 250,
      fps: 25,
      error: msg,
    };
  }
}

export const DynamicScene: React.FC<{ code?: string; svgContents?: SvgFrameSlot[] }> = ({ code, svgContents }) => {
  const Component = useMemo(() => {
    if (!code) return null;
    const result = evalSceneCode(code);
    return result?.component || null;
  }, [code]);

  if (!Component) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "#040D12",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#93B1A6",
          fontSize: 48,
          fontFamily: "sans-serif",
        }}
      >
        No scene loaded
      </AbsoluteFill>
    );
  }

  return (
    <SvgFramesProvider value={svgContents ?? []}>
      <Component />
    </SvgFramesProvider>
  );
};
