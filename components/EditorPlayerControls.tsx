"use client";

import React from "react";
import type { PlayerRef } from "@remotion/player";
import Icon from "@/components/ui/Icon";

/**
 * Transport bar for the editor's viewer.
 *
 * Replaces Remotion's built-in controls, which sat INSIDE the video box —
 * underneath the selection overlay, so clicking play hit the overlay instead and
 * appeared to do nothing. Living outside the video box, these can't be
 * intercepted, and they can show a proper timecode and frame stepping.
 */

/** HH:MM:SS:FF, the format an editor expects. */
export function timecode(frame: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 25;
  const total = Math.max(0, Math.round(frame));
  const frames = total % safeFps;
  const seconds = Math.floor(total / safeFps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}:${pad(frames)}`;
}

interface Props {
  playerRef?: React.RefObject<PlayerRef | null>;
  currentFrame: number;
  durationInFrames: number;
  fps: number;
  isPlaying?: boolean;
  onSeek?: (frame: number) => void;
  onTogglePlay?: () => void;
  loop: boolean;
  onLoopChange: (next: boolean) => void;
}

export default function EditorPlayerControls({
  playerRef, currentFrame, durationInFrames, fps, isPlaying,
  onSeek, onTogglePlay, loop, onLoopChange,
}: Props) {
  const last = Math.max(0, durationInFrames - 1);
  const step = (by: number) => onSeek?.(Math.max(0, Math.min(last, currentFrame + by)));

  return (
    <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-2)", borderTop: "0.5px solid var(--line-1)" }}>
      {/* Scrubber */}
      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={Math.min(currentFrame, last)}
        onChange={(e) => onSeek?.(parseInt(e.target.value, 10))}
        aria-label="Playhead"
        style={{ width: "100%", height: 3, margin: 0, accentColor: "var(--accent)", cursor: "pointer" }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px" }}>
        <span className="mono nums" style={{ fontSize: 10, color: "var(--accent)", minWidth: 86 }}>
          {timecode(currentFrame, fps)}
        </span>

        <div style={{ flex: 1 }} />

        <Btn title="Go to start" onClick={() => onSeek?.(0)} icon="skipBack" />
        <Btn title="Back one frame" onClick={() => step(-1)} icon="chevronLeft" />
        <Btn
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          onClick={() => onTogglePlay?.()}
          icon={isPlaying ? "pause" : "play"}
          emphasis
        />
        <Btn title="Forward one frame" onClick={() => step(1)} icon="chevronRight" />
        <Btn title="Go to end" onClick={() => onSeek?.(last)} icon="skipForward" />
        <Btn
          title={loop ? "Looping — click to play once" : "Play once — click to loop"}
          onClick={() => onLoopChange(!loop)}
          icon="loop"
          active={loop}
        />

        <div style={{ flex: 1 }} />

        <span className="mono nums" style={{ fontSize: 10, color: "var(--text-3)", minWidth: 86, textAlign: "right" }}>
          {timecode(last, fps)}
        </span>
        <Btn
          title="Fullscreen"
          onClick={() => { try { playerRef?.current?.requestFullscreen(); } catch { /* not available */ } }}
          icon="maximize"
        />
      </div>
    </div>
  );
}

function Btn({
  icon, title, onClick, active, emphasis,
}: {
  icon: string;
  title: string;
  onClick: () => void;
  active?: boolean;
  emphasis?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: emphasis ? 28 : 24, height: emphasis ? 28 : 24,
        background: emphasis ? "var(--bg-4)" : "transparent",
        border: emphasis ? "0.5px solid var(--line-2)" : "none",
        borderRadius: 4, cursor: "pointer", padding: 0,
      }}
    >
      <Icon
        name={icon}
        size={emphasis ? 14 : 12}
        style={{ color: active ? "var(--accent)" : "var(--text-1)" }}
      />
    </button>
  );
}
