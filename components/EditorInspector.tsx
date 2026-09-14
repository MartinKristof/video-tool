"use client";

import React from "react";
import ScrubNumber from "@/components/ui/ScrubNumber";
import {
  findItem, hasSource, setLayout, updateItem,
  type AudioItem, type CaptionsItem, type EditorDoc, type EditorItem, type SolidItem,
  type TextItem, type VideoItem,
} from "@/lib/editor-doc";
import { presetsFor } from "@/lib/editor-effects";

/**
 * Properties of the selected item. Everything here writes through the same pure
 * document operations the canvas and timeline use, so a number typed in this
 * panel and a handle dragged on the canvas are the same edit.
 */

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 };
const label: React.CSSProperties = { fontSize: 10, color: "var(--text-2)", width: 92, flexShrink: 0 };
const input: React.CSSProperties = {
  background: "var(--bg-3)", border: "0.5px solid var(--line-2)", borderRadius: 3,
  color: "var(--text-0)", fontSize: 11, padding: "3px 6px", width: "100%", minWidth: 0,
};

/** Thin wrapper so every field in this panel scrubs and types the same way. */
function NumberField({
  value, onCommit, step = 1, min, max, precision = 0, suffix, disabled,
}: {
  value: number;
  onCommit: (n: number, opts?: { transient?: boolean }) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <ScrubNumber
      value={Number.isFinite(value) ? value : 0}
      onChange={onCommit}
      step={step}
      min={min}
      max={max}
      precision={precision}
      suffix={suffix}
      disabled={disabled}
    />
  );
}

/** A labelled group, so the panel reads as sections rather than a wall of rows. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 9, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export default function EditorInspector({
  doc, selectedIds, onChange, onEditSnippet,
}: {
  doc: EditorDoc;
  selectedIds: Set<string>;
  /** `transient` values come from a drag in progress and must not be recorded for undo. */
  onChange: (next: EditorDoc, opts?: { transient?: boolean }) => void;
  /** Opens the snippet's parameter form, for blocks that came from the library. */
  onEditSnippet?: (itemId: string) => void;
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
  const patchLayout = (
    p: Parameters<typeof setLayout>[2],
    opts?: { transient?: boolean },
  ) => onChange(setLayout(doc, item.id, p), opts);

  return (
    <div style={{ padding: 10, overflowY: "auto", height: "100%" }}>
      <div className="mono cap" style={{ fontSize: 9, color: "var(--text-3)", marginBottom: 8 }}>
        {item.type} · {item.durationInFrames}f @ {item.from}
      </div>

      <Section title="Transform">
        <div style={row}>
          <span style={label}>Position</span>
          <NumberField value={l.x} onCommit={(n, o) => patchLayout({ x: n }, o)} />
          <NumberField value={l.y} onCommit={(n, o) => patchLayout({ y: n }, o)} />
        </div>
        <div style={row}>
          <span style={label}>Size</span>
          <NumberField value={l.width} onCommit={(n, o) => patchLayout({ width: Math.max(8, n) }, o)} />
          <NumberField value={l.height} onCommit={(n, o) => patchLayout({ height: Math.max(8, n) }, o)} />
        </div>
        <div style={row}>
          <span style={label}>Scale</span>
          <NumberField
            value={Math.round((l.width / doc.size.width) * 100)}
            suffix="%"
            min={1}
            onCommit={(pct, o) => {
              // Scale about the centre, so resizing doesn't shove the item across
              // the frame — which is what makes a percentage field usable at all.
              const ratio = l.height / l.width;
              const width = Math.max(8, Math.round((pct / 100) * doc.size.width));
              const height = Math.max(8, Math.round(width * ratio));
              patchLayout({
                width,
                height,
                x: Math.round(l.x + (l.width - width) / 2),
                y: Math.round(l.y + (l.height - height) / 2),
              }, o);
            }}
          />
          <span style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={label}>Rotation</span>
          <NumberField value={l.rotation ?? 0} suffix="°" onCommit={(n, o) => patchLayout({ rotation: n }, o)} />
          <button onClick={() => patchLayout({ rotation: ((l.rotation ?? 0) + 90) % 360 })} style={{ ...input, width: 40, cursor: "pointer" }}>+90°</button>
        </div>
        <div style={row}>
          <span style={label}>Opacity</span>
          <NumberField
            value={Math.round((l.opacity ?? 1) * 100)}
            suffix="%"
            min={0}
            max={100}
            onCommit={(n, o) => patchLayout({ opacity: n / 100 }, o)}
          />
          <span style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={label}>Corner radius</span>
          <NumberField value={l.cornerRadius ?? 0} min={0} onCommit={(n, o) => patchLayout({ cornerRadius: n }, o)} />
          <span style={{ flex: 1 }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <button style={{ ...input, cursor: "pointer" }} onClick={() => patchLayout({ x: Math.round((doc.size.width - l.width) / 2) })}>
            Center horizontally
          </button>
          <button style={{ ...input, cursor: "pointer" }} onClick={() => patchLayout({ y: Math.round((doc.size.height - l.height) / 2) })}>
            Center vertically
          </button>
          <button style={{ ...input, cursor: "pointer" }} onClick={() => patchLayout({ x: 0, y: 0, width: doc.size.width, height: doc.size.height })}>
            Fill the frame
          </button>
        </div>
      </Section>

      {item.type === "text" && (
        <Section title="Text">
          <div style={{ ...row, alignItems: "flex-start" }}>
            <span style={label}>Content</span>
            <textarea
              value={(item as TextItem).text}
              onChange={(e) => onChange(updateItem<TextItem>(doc, item.id, { text: e.target.value }))}
              rows={3}
              style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
            />
          </div>
          <div style={row}>
            <span style={label}>Font size</span>
            <NumberField
              value={(item as TextItem).style.fontSize}
              min={4}
              onCommit={(n, o) => onChange(updateItem<TextItem>(doc, item.id, { style: { ...(item as TextItem).style, fontSize: Math.max(4, n) } }), o)}
            />
            <span style={{ flex: 1 }} />
          </div>
          <div style={row}>
            <span style={label}>Color</span>
            <input
              type="color"
              value={(item as TextItem).style.color}
              onChange={(e) => onChange(updateItem<TextItem>(doc, item.id, { style: { ...(item as TextItem).style, color: e.target.value } }))}
              style={{ ...input, padding: 0, height: 24 }}
            />
          </div>
          <div style={row}>
            <span style={label}>Alignment</span>
            {(["left", "center", "right"] as const).map((al) => (
              <button
                key={al}
                onClick={() => onChange(updateItem<TextItem>(doc, item.id, { style: { ...(item as TextItem).style, align: al } }))}
                style={{
                  ...input, cursor: "pointer",
                  color: ((item as TextItem).style.align ?? "left") === al ? "var(--accent)" : "var(--text-1)",
                }}
              >
                {al === "left" ? "Left" : al === "center" ? "Center" : "Right"}
              </button>
            ))}
          </div>
        </Section>
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
            <span style={label}>Fade in / out</span>
            <NumberField
              value={(item as VideoItem).fadeInFrames ?? 0}
              onCommit={(n, o) => onChange(updateItem<AudioItem>(doc, item.id, { fadeInFrames: Math.max(0, Math.round(n)) }), o)}
            />
            <span style={{ ...label, width: 44 }}>Fade out</span>
            <NumberField
              value={(item as VideoItem).fadeOutFrames ?? 0}
              onCommit={(n, o) => onChange(updateItem<AudioItem>(doc, item.id, { fadeOutFrames: Math.max(0, Math.round(n)) }), o)}
            />
          </div>
          <div style={row}>
            <span style={label}>Playback speed</span>
            <NumberField
              step={0.05}
              value={(item as VideoItem).playbackRate ?? 1}
              onCommit={(n, o) => onChange(updateItem<AudioItem>(doc, item.id, { playbackRate: Math.max(0.25, Math.min(5, n)) }), o)}
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
            <span style={label}>Font size</span>
            <NumberField
              value={(item as CaptionsItem).style.fontSize}
              onCommit={(n, o) => onChange(updateItem<CaptionsItem>(doc, item.id, { style: { ...(item as CaptionsItem).style, fontSize: Math.max(4, n) } }), o)}
            />
          </div>
          <div style={row}>
            <span style={label}>Color</span>
            <input
              type="color"
              value={(item as CaptionsItem).style.color}
              onChange={(e) => onChange(updateItem<CaptionsItem>(doc, item.id, { style: { ...(item as CaptionsItem).style, color: e.target.value } }))}
              style={{ ...input, padding: 0, height: 24 }}
            />
          </div>
          <div style={row}>
            <span style={label}>Spoken word</span>
            <input
              type="color"
              title="Colour of the word being spoken"
              value={(item as CaptionsItem).highlightColor ?? "#F86606"}
              onChange={(e) => onChange(updateItem<CaptionsItem>(doc, item.id, { highlightColor: e.target.value }))}
              style={{ ...input, padding: 0, height: 24 }}
            />
          </div>
          <div style={row}>
            <span style={label}>Page duration</span>
            <NumberField
              step={100}
              value={(item as CaptionsItem).pageDurationMs ?? 1200}
              onCommit={(n, o) => onChange(updateItem<CaptionsItem>(doc, item.id, { pageDurationMs: Math.max(200, n) }), o)}
            />
          </div>
          <div style={row}>
            <span style={label}>Words per page</span>
            <NumberField
              value={(item as CaptionsItem).maxWordsPerPage ?? 6}
              onCommit={(n, o) => onChange(updateItem<CaptionsItem>(doc, item.id, { maxWordsPerPage: Math.max(1, Math.round(n)) }), o)}
            />
          </div>
        </>
      )}

      {item.type === "scene" && "snippet" in item && item.snippet && onEditSnippet && (
        <Section title="Snippet">
          <button style={{ ...input, cursor: "pointer" }} onClick={() => onEditSnippet(item.id)}>
            Edit {item.snippet.id} texts…
          </button>
        </Section>
      )}

      <Section title="Effects">
        {(["animateIn", "animateOut"] as const).map((edge) => {
          const spec = item[edge];
          return (
            <div key={edge} style={row}>
              <span style={label}>{edge === "animateIn" ? "Arrives" : "Leaves"}</span>
              <select
                value={spec?.preset ?? "none"}
                onChange={(e) => {
                  const preset = e.target.value as NonNullable<typeof spec>["preset"];
                  onChange(updateItem(doc, item.id, {
                    [edge]: preset === "none"
                      ? undefined
                      : { preset, durationInFrames: spec?.durationInFrames ?? 12 },
                  }));
                }}
                style={{ ...input, cursor: "pointer" }}
              >
                {presetsFor(item.type).map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              {/* Dead until a preset is chosen — there is no animation to give a
                  length to. It used to still show "12f" and silently ignore every
                  drag, which reads as broken rather than as not-applicable. */}
              <NumberField
                value={spec?.durationInFrames ?? 12}
                min={1}
                suffix="f"
                disabled={!spec}
                onCommit={(n, o) => {
                  if (!spec) return;
                  onChange(updateItem(doc, item.id, { [edge]: { ...spec, durationInFrames: Math.max(1, Math.round(n)) } }), o);
                }}
              />
            </div>
          );
        })}
      </Section>

      {item.type === "solid" && (
        <div style={row}>
          <span style={label}>Color</span>
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
