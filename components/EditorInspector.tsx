"use client";

import React from "react";
import {
  findItem, hasSource, setLayout, updateItem,
  type AudioItem, type CaptionsItem, type EditorDoc, type EditorItem, type SolidItem,
  type TextItem, type VideoItem,
} from "@/lib/editor-doc";

/**
 * Properties of the selected item. Everything here writes through the same pure
 * document operations the canvas and timeline use, so a number typed in this
 * panel and a handle dragged on the canvas are the same edit.
 */

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 };
const label: React.CSSProperties = { fontSize: 9, color: "var(--text-3)", width: 58, flexShrink: 0, textTransform: "uppercase", letterSpacing: "0.04em" };
const input: React.CSSProperties = {
  background: "var(--bg-3)", border: "0.5px solid var(--line-2)", borderRadius: 3,
  color: "var(--text-0)", fontSize: 11, padding: "3px 6px", width: "100%", minWidth: 0,
};

function NumberField({ value, onCommit, step = 1 }: { value: number; onCommit: (n: number) => void; step?: number }) {
  return (
    <input
      type="number"
      className="nums"
      step={step}
      value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) onCommit(n);
      }}
      style={input}
    />
  );
}

export default function EditorInspector({
  doc, selectedIds, onChange,
}: {
  doc: EditorDoc;
  selectedIds: Set<string>;
  onChange: (next: EditorDoc) => void;
}) {
  const id = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const found = id ? findItem(doc, id) : null;

  if (!found) {
    return (
      <div style={{ padding: 10, fontSize: 11, color: "var(--text-3)" }}>
        {selectedIds.size > 1
          ? `${selectedIds.size} items selected`
          : "Select something on the canvas or timeline"}
      </div>
    );
  }

  const item: EditorItem = found.item;
  const l = item.layout;
  const patchLayout = (p: Parameters<typeof setLayout>[2]) => onChange(setLayout(doc, item.id, p));

  return (
    <div style={{ padding: 10, overflowY: "auto", height: "100%" }}>
      <div className="mono cap" style={{ fontSize: 9, color: "var(--text-3)", marginBottom: 8 }}>
        {item.type} · {item.durationInFrames}f @ {item.from}
      </div>

      <div style={row}>
        <span style={label}>X / Y</span>
        <NumberField value={l.x} onCommit={(n) => patchLayout({ x: n })} />
        <NumberField value={l.y} onCommit={(n) => patchLayout({ y: n })} />
      </div>
      <div style={row}>
        <span style={label}>W / H</span>
        <NumberField value={l.width} onCommit={(n) => patchLayout({ width: Math.max(8, n) })} />
        <NumberField value={l.height} onCommit={(n) => patchLayout({ height: Math.max(8, n) })} />
      </div>
      <div style={row}>
        <span style={label}>Rotate</span>
        <NumberField value={l.rotation ?? 0} onCommit={(n) => patchLayout({ rotation: n })} />
        <button onClick={() => patchLayout({ rotation: ((l.rotation ?? 0) + 90) % 360 })} style={{ ...input, width: 34, cursor: "pointer" }}>90°</button>
      </div>
      <div style={row}>
        <span style={label}>Opacity</span>
        <input
          type="range" min={0} max={1} step={0.01}
          value={l.opacity ?? 1}
          onChange={(e) => patchLayout({ opacity: parseFloat(e.target.value) })}
          style={{ width: "100%" }}
        />
      </div>
      <div style={row}>
        <span style={label}>Radius</span>
        <NumberField value={l.cornerRadius ?? 0} onCommit={(n) => patchLayout({ cornerRadius: Math.max(0, n) })} />
      </div>

      <div style={{ display: "flex", gap: 4, marginTop: 8, marginBottom: 10 }}>
        <button style={{ ...input, cursor: "pointer" }} onClick={() => patchLayout({ x: Math.round((doc.size.width - l.width) / 2) })}>Centre H</button>
        <button style={{ ...input, cursor: "pointer" }} onClick={() => patchLayout({ y: Math.round((doc.size.height - l.height) / 2) })}>Centre V</button>
        <button style={{ ...input, cursor: "pointer" }} onClick={() => patchLayout({ x: 0, y: 0, width: doc.size.width, height: doc.size.height })}>Fill</button>
      </div>

      {item.type === "text" && (
        <>
          <div style={{ ...row, alignItems: "flex-start" }}>
            <span style={label}>Text</span>
            <textarea
              value={(item as TextItem).text}
              onChange={(e) => onChange(updateItem<TextItem>(doc, item.id, { text: e.target.value }))}
              rows={3}
              style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
            />
          </div>
          <div style={row}>
            <span style={label}>Size</span>
            <NumberField
              value={(item as TextItem).style.fontSize}
              onCommit={(n) => onChange(updateItem<TextItem>(doc, item.id, { style: { ...(item as TextItem).style, fontSize: Math.max(4, n) } }))}
            />
          </div>
          <div style={row}>
            <span style={label}>Colour</span>
            <input
              type="color"
              value={(item as TextItem).style.color}
              onChange={(e) => onChange(updateItem<TextItem>(doc, item.id, { style: { ...(item as TextItem).style, color: e.target.value } }))}
              style={{ ...input, padding: 0, height: 24 }}
            />
          </div>
          <div style={row}>
            <span style={label}>Align</span>
            {(["left", "center", "right"] as const).map((al) => (
              <button
                key={al}
                onClick={() => onChange(updateItem<TextItem>(doc, item.id, { style: { ...(item as TextItem).style, align: al } }))}
                style={{
                  ...input, cursor: "pointer",
                  color: (item as TextItem).style.align === al ? "var(--accent)" : "var(--text-1)",
                }}
              >
                {al[0].toUpperCase()}
              </button>
            ))}
          </div>
        </>
      )}

      {hasSource(item) && (
        <>
          <div style={{ fontSize: 9, color: "var(--text-3)", marginTop: 4, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Sound
          </div>
          <div style={row}>
            <span style={label}>Volume</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={(item as VideoItem).volume ?? 1}
              onChange={(e) => onChange(updateItem<AudioItem>(doc, item.id, { volume: parseFloat(e.target.value) }))}
              style={{ width: "100%" }}
            />
          </div>
          <div style={row}>
            <span style={label}>Fade in</span>
            <NumberField
              value={(item as VideoItem).fadeInFrames ?? 0}
              onCommit={(n) => onChange(updateItem<AudioItem>(doc, item.id, { fadeInFrames: Math.max(0, Math.round(n)) }))}
            />
            <span style={{ ...label, width: 44 }}>Fade out</span>
            <NumberField
              value={(item as VideoItem).fadeOutFrames ?? 0}
              onCommit={(n) => onChange(updateItem<AudioItem>(doc, item.id, { fadeOutFrames: Math.max(0, Math.round(n)) }))}
            />
          </div>
          <div style={row}>
            <span style={label}>Speed</span>
            <NumberField
              step={0.05}
              value={(item as VideoItem).playbackRate ?? 1}
              onCommit={(n) => onChange(updateItem<AudioItem>(doc, item.id, { playbackRate: Math.max(0.25, Math.min(5, n)) }))}
            />
          </div>
          <div style={{ fontSize: 9, color: "var(--text-3)", marginBottom: 8 }}>
            Source {((item as VideoItem).sourceIn ?? 0).toFixed(2)}s – {((item as VideoItem).sourceOut ?? 0).toFixed(2)}s
          </div>
        </>
      )}

      {item.type === "captions" && (
        <>
          <div style={{ fontSize: 10, color: "var(--text-3)", marginBottom: 8 }}>
            {(item as CaptionsItem).tokens.length} words transcribed
          </div>
          <div style={row}>
            <span style={label}>Size</span>
            <NumberField
              value={(item as CaptionsItem).style.fontSize}
              onCommit={(n) => onChange(updateItem<CaptionsItem>(doc, item.id, { style: { ...(item as CaptionsItem).style, fontSize: Math.max(4, n) } }))}
            />
          </div>
          <div style={row}>
            <span style={label}>Colour</span>
            <input
              type="color"
              value={(item as CaptionsItem).style.color}
              onChange={(e) => onChange(updateItem<CaptionsItem>(doc, item.id, { style: { ...(item as CaptionsItem).style, color: e.target.value } }))}
              style={{ ...input, padding: 0, height: 24 }}
            />
          </div>
          <div style={row}>
            <span style={label}>Spoken</span>
            <input
              type="color"
              title="Colour of the word being spoken"
              value={(item as CaptionsItem).highlightColor ?? "#F86606"}
              onChange={(e) => onChange(updateItem<CaptionsItem>(doc, item.id, { highlightColor: e.target.value }))}
              style={{ ...input, padding: 0, height: 24 }}
            />
          </div>
          <div style={row}>
            <span style={label}>Page ms</span>
            <NumberField
              step={100}
              value={(item as CaptionsItem).pageDurationMs ?? 1200}
              onCommit={(n) => onChange(updateItem<CaptionsItem>(doc, item.id, { pageDurationMs: Math.max(200, n) }))}
            />
          </div>
          <div style={row}>
            <span style={label}>Max words</span>
            <NumberField
              value={(item as CaptionsItem).maxWordsPerPage ?? 6}
              onCommit={(n) => onChange(updateItem<CaptionsItem>(doc, item.id, { maxWordsPerPage: Math.max(1, Math.round(n)) }))}
            />
          </div>
        </>
      )}

      {item.type === "solid" && (
        <div style={row}>
          <span style={label}>Colour</span>
          <input
            type="color"
            value={(item as SolidItem).color}
            onChange={(e) => onChange(updateItem<SolidItem>(doc, item.id, { color: e.target.value }))}
            style={{ ...input, padding: 0, height: 24 }}
          />
        </div>
      )}
    </div>
  );
}
