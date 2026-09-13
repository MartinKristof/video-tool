"use client";

import React from "react";
import {
  ANIMATION_PRESETS, presetsFor, type AnimationPreset, type PresetInfo,
} from "@/lib/editor-effects";
import { findItem, updateItem, type EditorDoc, type EditorItem } from "@/lib/editor-doc";

/**
 * In/out animations you can drag onto a clip.
 *
 * The list is short on purpose. Most of a stock transitions panel — fades from
 * black, blur reveals, slides and wipes — is banned in this project, and what's
 * left is the vocabulary the branded scenes actually use: opacity combined with
 * translate, scale and rotation, plus real per-character typing.
 */

interface Props {
  doc: EditorDoc;
  selectedIds: Set<string>;
  onChange: (next: EditorDoc) => void;
}

const DEFAULT_FRAMES = 12;

export default function EffectsPanel({ doc, selectedIds, onChange }: Props) {
  const id = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const found = id ? findItem(doc, id) : null;
  const item = found?.item;

  const apply = (preset: AnimationPreset, edge: "in" | "out", target?: EditorItem) => {
    const t = target ?? item;
    if (!t) return;
    const spec = preset === "none" ? undefined : { preset, durationInFrames: DEFAULT_FRAMES };
    onChange(updateItem(doc, t.id, edge === "in" ? { animateIn: spec } : { animateOut: spec }));
  };

  const available: PresetInfo[] = item ? presetsFor(item.type) : ANIMATION_PRESETS;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 10 }}>
      {!item && (
        <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 10 }}>
          Select a clip, then click an effect — or drag one onto a clip on the timeline.
        </div>
      )}
      {item && (
        <div className="mono cap" style={{ fontSize: 9, color: "var(--text-3)", marginBottom: 8 }}>
          {item.type} · in: {item.animateIn?.preset ?? "cut"} · out: {item.animateOut?.preset ?? "cut"}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {available.map((p) => (
          <div
            key={p.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-vt-effect", p.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
              background: "var(--bg-3)", border: "0.5px solid var(--line-2)",
              borderRadius: "var(--r-sm)", cursor: "grab",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--text-0)" }}>{p.label}</div>
              <div style={{ fontSize: 9, color: "var(--text-3)" }}>{p.hint}</div>
            </div>
            <button disabled={!item} onClick={() => apply(p.id, "in")} style={chip(Boolean(item))}>In</button>
            <button disabled={!item} onClick={() => apply(p.id, "out")} style={chip(Boolean(item))}>Out</button>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 9, color: "var(--text-3)", marginTop: 12, lineHeight: 1.5 }}>
        Elements arrive sharp — no blur reveals, no fades from black, no slides or wipes.
        Typing is genuinely per character.
      </div>
    </div>
  );
}

const chip = (enabled: boolean): React.CSSProperties => ({
  background: "var(--bg-4)", border: "0.5px solid var(--line-2)", borderRadius: 3,
  color: enabled ? "var(--text-1)" : "var(--text-3)", fontSize: 9,
  padding: "2px 7px", cursor: enabled ? "pointer" : "default",
});
