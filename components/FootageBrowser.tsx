"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import { addItem, makeId, type Asset, type EditorDoc, type EditorItem } from "@/lib/editor-doc";

/**
 * Everything imported into this project, in one place — and the way to import
 * more. Until now media could only be attached when the project was created.
 */

export interface MediaFile {
  name: string;
  path: string;
  type: "video" | "audio" | "image" | "other";
}

interface Props {
  projectId: string;
  doc: EditorDoc;
  onChange: (next: EditorDoc) => void;
  currentFrame: number;
  onSelect?: (itemId: string) => void;
}

/**
 * Read a media file's length in the browser. A freshly uploaded file isn't in
 * the ffprobe cache yet, and a hidden element answers this in milliseconds.
 */
export function readMediaDuration(src: string, kind: "video" | "audio") {
  return new Promise<number | undefined>((resolve) => {
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    const done = (v: number | undefined) => { el.removeAttribute("src"); resolve(v); };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : undefined);
    el.onerror = () => done(undefined);
    window.setTimeout(() => done(undefined), 8000);
    el.src = src;
  });
}

export default function FootageBrowser({ projectId, doc, onChange, currentFrame, onSelect }: Props) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    fetch(`/api/media/${projectId}/list`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.files)) setFiles(d.files); })
      .catch(() => {});
    fetch(`/api/media/${projectId}/probe-map`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.fps || !d?.nbFrames) return;
        const out: Record<string, number> = {};
        for (const [rel, frames] of Object.entries(d.nbFrames as Record<string, number>)) {
          const f = (d.fps as Record<string, number>)[rel];
          if (f) out[rel] = frames / f;
        }
        setDurations(out);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const upload = useCallback(async (picked: File[]) => {
    setError(null);
    for (const file of picked) {
      setBusy(file.name);
      try {
        const res = await fetch(
          `/api/media/${projectId}/upload?name=${encodeURIComponent(file.name)}`,
          { method: "POST", body: file },
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Upload failed");
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : "Upload failed"}`);
      }
    }
    setBusy(null);
    refresh();
  }, [projectId, refresh]);

  // ⌘I / Ctrl+I opens the picker, as in every editor.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.closest(".monaco-editor"))) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        inputRef.current?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Place a file on the last track at the playhead. */
  const insert = useCallback(async (file: MediaFile) => {
    const src = `/api/media/${projectId}/${file.path}`;
    const kind: Asset["kind"] = file.type === "audio" ? "audio" : file.type === "image" ? "image" : "video";
    const existing = doc.assets.find((a) => a.src === src);
    const durationSec = existing?.durationSec
      ?? durations[file.path]
      ?? (kind === "image" ? undefined : await readMediaDuration(src, kind));
    const asset: Asset = existing ?? { id: makeId("asset"), kind, src, name: file.name, durationSec };
    const trackId = doc.tracks[doc.tracks.length - 1]?.id;
    if (!trackId) return;

    const item = {
      type: kind === "audio" ? "audio" : kind === "image" ? "image" : "video",
      id: makeId(kind),
      from: currentFrame,
      durationInFrames: Math.max(1, Math.round((durationSec ?? 3) * doc.size.fps)),
      layout: { x: 0, y: 0, width: doc.size.width, height: doc.size.height },
      assetId: asset.id,
      ...(kind === "video" || kind === "audio" ? { sourceIn: 0, sourceOut: durationSec } : {}),
    } as EditorItem;

    onChange(addItem(existing ? doc : { ...doc, assets: [...doc.assets, asset] }, trackId, item));
    onSelect?.(item.id);
  }, [doc, projectId, durations, currentFrame, onChange, onSelect]);

  const used = new Set(doc.assets.map((a) => a.src));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: "0.5px solid var(--line-1)" }}>
        <button onClick={() => inputRef.current?.click()} style={btn}>Import…</button>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-3)" }}>⌘I</span>
        {busy && <span className="mono" style={{ fontSize: 9, color: "var(--accent)" }}>uploading {busy}…</span>}
        {error && <span className="mono" style={{ fontSize: 9, color: "#f87171" }}>{error}</span>}
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 9, color: "var(--text-3)" }}>{files.length} files</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length) void upload(picked);
        }}
      />

      <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: 8, alignContent: "start" }}>
        {files.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-3)", gridColumn: "1 / -1" }}>
            Nothing imported yet — press Import or ⌘I, or drop files onto a track.
          </div>
        )}
        {files.map((f) => {
          const src = `/api/media/${projectId}/${f.path}`;
          const strip = `/api/media/${projectId}/filmstrip?file=${encodeURIComponent(f.path)}`;
          return (
            <button
              key={f.path}
              onClick={() => void insert(f)}
              title={`${f.name} — click to add at the playhead`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("application/x-vt-media", JSON.stringify(f))}
              style={{
                display: "flex", flexDirection: "column", gap: 4, padding: 0,
                background: "none", border: "none", cursor: "pointer", textAlign: "left",
              }}
            >
              <div
                style={{
                  width: "100%", aspectRatio: "16 / 9", borderRadius: "var(--r-sm)",
                  border: `0.5px solid ${used.has(src) ? "var(--accent-line)" : "var(--line-2)"}`,
                  overflow: "hidden", background: "var(--bg-inset)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  // The filmstrip is already generated for the timeline; show its
                  // first frame rather than decoding anything here.
                  ...(f.type === "video"
                    ? { backgroundImage: `url(${strip})`, backgroundSize: "auto 100%", backgroundRepeat: "no-repeat" }
                    : {}),
                }}
              >
                {f.type === "image" && (
                  // eslint-disable-next-line @next/next/no-img-element -- local project media, same as AssetBrowser
                  <img src={src} alt={f.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                )}
                {f.type === "audio" && <Icon name="monitor" size={16} style={{ color: "var(--text-3)" }} />}
              </div>
              <span className="mono" style={{ fontSize: 9, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "var(--bg-3)", border: "0.5px solid var(--line-2)", borderRadius: 3,
  color: "var(--text-1)", fontSize: 10, padding: "3px 9px", cursor: "pointer",
};
