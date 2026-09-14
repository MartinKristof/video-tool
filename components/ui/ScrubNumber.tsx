"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * A number you can drag to change, or double-click to type.
 *
 * The interaction every editor has and this app didn't: press and drag sideways
 * to scrub the value, double-click to edit it as text, Enter to commit, Escape
 * to abandon. Shift makes it fine, Alt makes it coarse.
 */

export interface ScrubNumberProps {
  value: number;
  /**
   * `transient` marks the intermediate values produced while dragging. The
   * consumer should apply them but not record them for undo, and treat the
   * final call — without the flag — as the one edit that happened.
   */
  onChange: (next: number, opts?: { transient?: boolean }) => void;
  /** Units per pixel dragged. */
  step?: number;
  min?: number;
  max?: number;
  /** Decimal places shown and committed. */
  precision?: number;
  suffix?: string;
  disabled?: boolean;
}

/** Value after dragging `dx` pixels. Pure, so the modifier maths is testable. */
export function scrubValue(
  start: number,
  dx: number,
  step: number,
  modifiers: { shift?: boolean; alt?: boolean } = {},
  bounds: { min?: number; max?: number } = {},
): number {
  const scale = modifiers.shift ? 0.1 : modifiers.alt ? 10 : 1;
  let next = start + dx * step * scale;
  if (bounds.min != null) next = Math.max(bounds.min, next);
  if (bounds.max != null) next = Math.min(bounds.max, next);
  return next;
}

export default function ScrubNumber({
  value, onChange, step = 1, min, max, precision = 0, suffix, disabled,
}: ScrubNumberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null);
  const movedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const round = useCallback(
    (n: number) => Number(n.toFixed(precision)),
    [precision],
  );

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled || editing) return;
    e.preventDefault();
    // Capture the pointer on this element: without it a fast drag that leaves
    // the field can be swallowed by whatever it passes over, and the value stops
    // following the cursor.
    const target = e.currentTarget as HTMLElement;
    try { target.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    dragRef.current = { startX: e.clientX, startValue: value };
    movedRef.current = false;

    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      if (Math.abs(dx) > 2) movedRef.current = true;
      onChange(
        round(scrubValue(d.startValue, dx, step, { shift: ev.shiftKey, alt: ev.altKey }, { min, max })),
        { transient: true },
      );
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      // One committed value at the end of the drag, so it counts as a single
      // edit rather than one per pixel travelled.
      if (d && movedRef.current) {
        const dx = ev.clientX - d.startX;
        onChange(round(scrubValue(d.startValue, dx, step, { shift: ev.shiftKey, alt: ev.altKey }, { min, max })));
      }
      dragRef.current = null;
      try { target.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [disabled, editing, value, step, min, max, onChange, round]);

  const commit = useCallback(() => {
    const parsed = parseFloat(draft);
    if (Number.isFinite(parsed)) {
      let next = parsed;
      if (min != null) next = Math.max(min, next);
      if (max != null) next = Math.min(max, next);
      onChange(round(next));
    }
    setEditing(false);
  }, [draft, min, max, onChange, round]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          e.stopPropagation();
        }}
        className="nums"
        style={{ ...field, cursor: "text", outline: "1px solid var(--accent-line)" }}
      />
    );
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={() => { if (!disabled) { setDraft(String(round(value))); setEditing(true); } }}
      className="nums"
      role="spinbutton"
      aria-valuenow={value}
      title="Drag to change · double-click to type · Shift for fine, Alt for coarse"
      style={{
        ...field,
        cursor: disabled ? "default" : "ew-resize",
        color: disabled ? "var(--text-3)" : "var(--text-0)",
        userSelect: "none",
      }}
    >
      {round(value)}{suffix ?? ""}
    </div>
  );
}

const field: React.CSSProperties = {
  background: "var(--bg-3)",
  border: "0.5px solid var(--line-2)",
  borderRadius: 3,
  color: "var(--text-0)",
  fontSize: 11,
  padding: "3px 6px",
  width: "100%",
  // Wide enough to actually grab. Sharing a flex row with a dropdown, a
  // `width: 100%` field with no floor can be squeezed to a few pixels, which
  // looks present but is impossible to drag.
  minWidth: 46,
  boxSizing: "border-box",
  textAlign: "right",
};
