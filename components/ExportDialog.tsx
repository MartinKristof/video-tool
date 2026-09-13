"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";
import IconButton from "@/components/ui/IconButton";
import Input from "@/components/ui/Input";
import Segmented from "@/components/ui/Segmented";
import { formatBytes } from "@/lib/format";
import type { Engine } from "@/lib/types";
import type { EditorDoc } from "@/lib/editor-doc";

interface RenderPreset {
  name: string;
  codec: string;
  builtIn?: boolean;
}

const BUILT_IN_PRESETS: RenderPreset[] = [
  { name: "YouTube 4K", codec: "h264", builtIn: true },
  { name: "Instagram Reel", codec: "h264", builtIn: true },
  { name: "Color Grading", codec: "prores-xq", builtIn: true },
  { name: "Compositing", codec: "prores", builtIn: true },
  { name: "No Background", codec: "prores", builtIn: true },
  { name: "CapCut (Transparent)", codec: "hevc-alpha", builtIn: true },
  { name: "OBS (Transparent .mov)", codec: "qtrle", builtIn: true },
];

function loadUserPresets(): RenderPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem("vt-render-presets");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveUserPresets(presets: RenderPreset[]) {
  localStorage.setItem("vt-render-presets", JSON.stringify(presets));
}

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  code: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  projectName: string;
  projectId?: string;
  engine?: Engine;
  /**
   * Present for visual-editor projects. Sent with the render so the export uses
   * the document currently on screen rather than the copy on disk, which the
   * editor's debounced save can leave a couple of seconds behind.
   */
  doc?: EditorDoc;
}

export default function ExportDialog({
  open,
  onClose,
  code,
  durationInFrames,
  fps,
  width,
  height,
  projectName,
  projectId,
  engine,
  doc,
}: ExportDialogProps) {
  // HyperFrames uses its own format selector (MP4 opaque / WebM · MOV transparent)
  // instead of the Remotion codec list.
  const isHyperframes = engine === "hyperframes";
  const visiblePresets = isHyperframes ? BUILT_IN_PRESETS.filter((p) => p.codec === "h264") : BUILT_IN_PRESETS;
  const [status, setStatus] = useState<"idle" | "queued" | "rendering" | "done" | "error">("idle");
  // While rendering, closing is guarded (the render runs server-side and never
  // stops) — this drives the "close anyway?" confirmation.
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState(projectName.replace(/\s+/g, "-").toLowerCase());
  const [codec, setCodec] = useState<string>("h264");
  const [hfFormat, setHfFormat] = useState<"mp4" | "webm" | "mov">("mp4");
  // Color-grade LUT — applied at export on the h264 path only (see render-queue).
  const [luts, setLuts] = useState<{ id: string; name: string; builtIn: boolean }[]>([]);
  const [lutId, setLutId] = useState<string>("none");
  const [uploadingLut, setUploadingLut] = useState(false);
  const lutInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Delivered file extension — HyperFrames by format, Remotion by codec.
  const ext = isHyperframes ? hfFormat : codec === "h264" ? "mp4" : "mov";

  const [presetOpen, setPresetOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [userPresets, setUserPresets] = useState<RenderPreset[]>([]);
  const [savePresetName, setSavePresetName] = useState("");
  const [showSavePreset, setShowSavePreset] = useState(false);
  const presetRef = useRef<HTMLDivElement>(null);

  const [cacheStats, setCacheStats] = useState<{ count: number; totalBytes: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const refreshCacheStats = useCallback(async () => {
    try {
      const res = await fetch("/api/renders/cleanup");
      if (res.ok) setCacheStats(await res.json());
    } catch {}
  }, []);

  async function handleClearRenders() {
    if (cleaning) return;
    setCleaning(true);
    try {
      await fetch("/api/renders/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await refreshCacheStats();
    } finally {
      setCleaning(false);
    }
  }

  useEffect(() => {
    setUserPresets(loadUserPresets());
    try {
      const v = localStorage.getItem("vt-export-lut");
      if (v) setLutId(v);
    } catch {}
  }, []);

  const refreshLuts = useCallback(async () => {
    try {
      const res = await fetch("/api/luts");
      if (res.ok) {
        const d = await res.json();
        setLuts(d.luts || []);
      }
    } catch {}
  }, []);

  // Load the available LUTs when the dialog opens.
  useEffect(() => {
    if (open) refreshLuts();
  }, [open, refreshLuts]);

  const selectLut = useCallback((id: string) => {
    setLutId(id);
    try {
      localStorage.setItem("vt-export-lut", id);
    } catch {}
  }, []);

  async function handleLutUpload(file: File) {
    setUploadingLut(true);
    try {
      const res = await fetch(`/api/luts/upload?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      if (res.ok) {
        const d = await res.json();
        await refreshLuts();
        if (d.id) selectLut(d.id);
      }
    } catch {
      // Non-fatal — the picker just won't gain the new entry.
    } finally {
      setUploadingLut(false);
    }
  }

  useEffect(() => {
    if (codec === "prores-xq") setShowAdvanced(true);
  }, [codec]);

  useEffect(() => {
    if (open) refreshCacheStats();
  }, [open, refreshCacheStats, status]);

  // Reset the close-confirmation whenever the dialog (re)opens.
  useEffect(() => {
    if (open) setConfirmingClose(false);
  }, [open]);

  const isRendering = status === "queued" || status === "rendering";

  // Warn before a tab close / refresh while a render is in progress. (The render
  // itself keeps running server-side regardless — this just prevents losing the
  // live view + auto-download by accident.)
  useEffect(() => {
    if (!isRendering) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isRendering]);

  useEffect(() => {
    if (!presetOpen) return;
    function handleClick(e: MouseEvent) {
      if (presetRef.current && !presetRef.current.contains(e.target as Node)) setPresetOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [presetOpen]);

  function applyPreset(preset: RenderPreset) {
    setCodec(preset.codec);
    setPresetOpen(false);
  }

  function handleSavePreset() {
    if (!savePresetName.trim()) return;
    const newPreset: RenderPreset = { name: savePresetName.trim(), codec };
    const updated = [...userPresets, newPreset];
    setUserPresets(updated);
    saveUserPresets(updated);
    setSavePresetName("");
    setShowSavePreset(false);
  }

  function deleteUserPreset(index: number) {
    const updated = userPresets.filter((_, i) => i !== index);
    setUserPresets(updated);
    saveUserPresets(updated);
  }

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  async function handleExport() {
    if (!code.trim()) return;

    setStatus("queued");
    setProgress(0);
    setDownloadUrl(null);
    setError(null);

    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, durationInFrames, fps, width, height, codec: isHyperframes ? "h264" : codec, projectId, engine, format: hfFormat, lut: !isHyperframes && codec === "h264" ? lutId : undefined, ...(doc ? { doc } : {}) }),
      });

      if (!res.ok) throw new Error("Failed to enqueue render");

      const job = await res.json();
      const jobId = job.id;

      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/render/${jobId}`);
          const statusData = await statusRes.json();

          setStatus(statusData.status);
          setProgress(statusData.progress);

          if (statusData.status === "done") {
            stopPolling();
            setDownloadUrl(statusData.outputPath);
            new Audio("/assets/render-complete.m4a").play().catch(() => {});
            const a = document.createElement("a");
            a.href = statusData.outputPath;
            a.download = `${fileName || "export"}.${ext}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
          } else if (statusData.status === "error") {
            stopPolling();
            setError(statusData.error);
          }
        } catch {
          stopPolling();
          setStatus("error");
          setError("Failed to check render status");
        }
      }, 1000);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  function handleClose() {
    // Don't tear down a render on close — ask first (X button while rendering).
    if (isRendering) {
      setConfirmingClose(true);
      return;
    }
    stopPolling();
    setStatus("idle");
    setProgress(0);
    setDownloadUrl(null);
    setError(null);
    onClose();
  }

  // Close the dialog but leave the render running: keep polling so it still
  // auto-downloads when done, and reopening shows live progress.
  function closeKeepingRender() {
    setConfirmingClose(false);
    onClose();
  }

  const seconds = (durationInFrames / fps).toFixed(1);
  const stats = [
    { label: "Resolution", value: `${width}\u00d7${height}` },
    { label: "Duration", value: `${seconds}s` },
    { label: "FPS", value: String(fps) },
    {
      label: isHyperframes ? "Format" : "Codec",
      value: isHyperframes
        ? (hfFormat === "mp4" ? "MP4 (opaque)" : hfFormat === "webm" ? "WebM (transparent)" : "MOV (transparent)")
        : codec === "h264" ? "Classic" : codec === "prores" ? "Transparent Background" : codec === "prores-xq" ? "Color Grading" : codec === "hevc-alpha" ? "CapCut" : "OBS",
    },
  ];

  return (
    <Modal open={open} onClose={handleClose} width={480} title="Export" stepLabel="Render to file" dismissible={!isRendering}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Presets */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ position: "relative" }} ref={presetRef}>
            <Button variant="outline" size="sm" icon="settings" onClick={() => setPresetOpen(!presetOpen)}>
              Presets <Icon name="chevronDown" size={12} />
            </Button>
            {presetOpen && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: "100%",
                  marginTop: 6,
                  minWidth: 220,
                  padding: 5,
                  background: "var(--bg-3)",
                  border: "0.5px solid var(--line-2)",
                  borderRadius: "var(--r-sm)",
                  boxShadow: "var(--sh-float)",
                  zIndex: 10,
                }}
              >
                <div className="mono cap" style={{ padding: "6px 8px", color: "var(--text-3)" }}>
                  Built-in
                </div>
                {visiblePresets.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "7px 8px",
                      fontSize: 12,
                      background: "transparent",
                      border: "none",
                      color: "var(--text-0)",
                      borderRadius: 4,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-4)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <span style={{ flex: 1 }}>{p.name}</span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
                      {p.codec === "h264" ? "H.264" : p.codec === "prores" ? "ProRes" : p.codec === "prores-xq" ? "XQ" : "QT-RLE"}
                    </span>
                  </button>
                ))}
                {userPresets.length > 0 && (
                  <>
                    <div style={{ height: 1, background: "var(--line-1)", margin: "4px 0" }} />
                    <div className="mono cap" style={{ padding: "6px 8px", color: "var(--text-3)" }}>
                      Custom
                    </div>
                    {userPresets.map((p, i) => (
                      <div
                        key={i}
                        style={{ display: "flex", alignItems: "center" }}
                      >
                        <button
                          onClick={() => applyPreset(p)}
                          style={{
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 8px",
                            fontSize: 12,
                            background: "transparent",
                            border: "none",
                            color: "var(--text-0)",
                            borderRadius: 4,
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-4)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <span style={{ flex: 1 }}>{p.name}</span>
                          <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
                            {p.codec === "h264" ? "H.264" : p.codec === "prores" ? "ProRes" : p.codec === "prores-xq" ? "XQ" : "QT-RLE"}
                          </span>
                        </button>
                        <IconButton icon="close" size={20} onClick={() => deleteUserPreset(i)} />
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {!showSavePreset ? (
            <Button variant="ghost" size="sm" onClick={() => setShowSavePreset(true)}>
              Save as preset
            </Button>
          ) : (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <Input
                value={savePresetName}
                onChange={setSavePresetName}
                placeholder="Preset name"
                autoFocus
                style={{ height: 26, fontSize: 11, width: 140 }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); if (e.key === "Escape") setShowSavePreset(false); }}
              />
              <Button variant="primary" size="sm" onClick={handleSavePreset} disabled={!savePresetName.trim()}>
                Save
              </Button>
              <IconButton icon="close" size={22} onClick={() => setShowSavePreset(false)} />
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {stats.map((s) => (
            <div
              key={s.label}
              style={{
                padding: 12,
                background: "var(--bg-inset)",
                border: "0.5px solid var(--line-2)",
                borderRadius: "var(--r-sm)",
              }}
            >
              <div className="mono cap" style={{ color: "var(--text-2)", marginBottom: 4 }}>
                {s.label}
              </div>
              <div className="mono nums" style={{ fontSize: 14, fontWeight: 600, letterSpacing: -0.2 }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        {/* Format — HyperFrames (MP4 opaque / WebM · MOV transparent) */}
        {isHyperframes && (
          <div>
            <div className="mono cap" style={{ color: "var(--text-1)", marginBottom: 8 }}>
              Format
            </div>
            <Segmented
              value={hfFormat}
              onChange={(v) => setHfFormat(v as "mp4" | "webm" | "mov")}
              options={[
                { value: "mp4", label: "MP4" },
                { value: "webm", label: "WebM" },
                { value: "mov", label: "MOV" },
              ]}
            />
            <div
              style={{
                marginTop: 6, padding: 8, fontSize: 11, color: "var(--text-2)",
                background: hfFormat === "mp4" ? "var(--bg-inset)" : "var(--accent-soft)",
                borderRadius: 4,
                border: hfFormat === "mp4" ? "0.5px solid var(--line-2)" : "0.5px solid var(--accent-line)",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              <Icon name="info" size={12} style={{ color: hfFormat === "mp4" ? "var(--text-3)" : "var(--accent)" }} />
              {hfFormat === "mp4"
                ? "H.264 .mp4 — opaque. Best for YouTube, social, and most playback."
                : hfFormat === "webm"
                  ? "VP9 .webm — transparent background (alpha). Great for overlays, OBS, and the web."
                  : "ProRes 4444 .mov — transparent background (alpha), 10-bit. Best for editing / compositing."}
            </div>
          </div>
        )}

        {/* Codec — Remotion only */}
        {!isHyperframes && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div className="mono cap" style={{ color: "var(--text-1)" }}>
              Codec
            </div>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="mono cap"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10,
                background: "transparent",
                border: "none",
                color: "var(--text-3)",
                cursor: "pointer",
                padding: "2px 4px",
              }}
            >
              <Icon name={showAdvanced ? "chevronDown" : "chevronRight"} size={10} />
              Advanced
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Segmented
              value={codec}
              onChange={(v) => setCodec(v as string)}
              options={[
                { value: "h264", label: "Classic" },
                { value: "prores", label: "Transparent Background" },
                { value: "hevc-alpha", label: "CapCut" },
                { value: "qtrle", label: "OBS" },
                ...(showAdvanced ? [{ value: "prores-xq", label: "Color Grading" }] : []),
              ]}
            />
            {codec === "h264" && (
              <div
                style={{
                  padding: 8,
                  fontSize: 11,
                  color: "var(--text-2)",
                  background: "var(--bg-inset)",
                  borderRadius: 4,
                  border: "0.5px solid var(--line-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="info" size={12} style={{ color: "var(--text-3)" }} />
                H.264 — .mp4, no transparency. Best for YouTube, social, and most playback.
              </div>
            )}
            {codec === "prores" && (
              <div
                style={{
                  padding: 8,
                  fontSize: 11,
                  color: "var(--text-2)",
                  background: "var(--amber-soft)",
                  borderRadius: 4,
                  border: "0.5px solid color-mix(in oklab, var(--amber) 30%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="info" size={12} style={{ color: "var(--amber)" }} />
                ProRes 4444 — .mov with alpha channel. Good for compositing.
              </div>
            )}
            {codec === "qtrle" && (
              <div
                style={{
                  padding: 8,
                  fontSize: 11,
                  color: "var(--text-2)",
                  background: "var(--accent-soft)",
                  borderRadius: 4,
                  border: "0.5px solid var(--accent-line)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="info" size={12} style={{ color: "var(--accent)" }} />
                QuickTime Animation (RLE) — .mov with ARGB alpha channel. Drop into OBS as a Media Source. Large files.
              </div>
            )}
            {codec === "hevc-alpha" && (
              <div
                style={{
                  padding: 8,
                  fontSize: 11,
                  color: "var(--text-2)",
                  background: "var(--accent-soft)",
                  borderRadius: 4,
                  border: "0.5px solid var(--accent-line)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="info" size={12} style={{ color: "var(--accent)" }} />
                HEVC with alpha — .mov, transparent, Apple&apos;s native format. Best for CapCut Mac, Final Cut, Motion. Small file size. macOS only.
              </div>
            )}
            {codec === "prores-xq" && (
              <div
                style={{
                  padding: 8,
                  fontSize: 11,
                  color: "var(--text-2)",
                  background: "var(--accent-soft)",
                  borderRadius: 4,
                  border: "0.5px solid var(--accent-line)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="info" size={12} style={{ color: "var(--accent)" }} />
                ProRes 4444 XQ — highest quality, 10-bit 4:4:4, alpha channel. Best for color grading. Large files.
              </div>
            )}
          </div>
        </div>
        )}

        {/* Look (LUT) — color grade, h264 export only */}
        {!isHyperframes && codec === "h264" && (
          <div>
            <div className="mono cap" style={{ color: "var(--text-1)", marginBottom: 8 }}>
              Look (LUT)
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select
                value={lutId}
                onChange={(e) => selectLut(e.target.value)}
                className="mono"
                style={{
                  flex: 1,
                  height: 32,
                  padding: "0 8px",
                  fontSize: 12,
                  background: "var(--bg-3)",
                  color: "var(--text-0)",
                  border: "0.5px solid var(--line-2)",
                  borderRadius: "var(--r-sm)",
                  cursor: "pointer",
                }}
              >
                <option value="none">None</option>
                {luts.some((l) => l.builtIn) && (
                  <optgroup label="Built-in">
                    {luts.filter((l) => l.builtIn).map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </optgroup>
                )}
                {luts.some((l) => !l.builtIn) && (
                  <optgroup label="Custom">
                    {luts.filter((l) => !l.builtIn).map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <Button
                variant="outline"
                size="sm"
                icon="upload"
                onClick={() => lutInputRef.current?.click()}
                disabled={uploadingLut}
              >
                {uploadingLut ? "Uploading…" : ".cube"}
              </Button>
              <input
                ref={lutInputRef}
                type="file"
                accept=".cube"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleLutUpload(f);
                  e.target.value = "";
                }}
              />
            </div>
            <div
              style={{
                marginTop: 6,
                padding: 8,
                fontSize: 11,
                color: "var(--text-2)",
                background: "var(--bg-inset)",
                borderRadius: 4,
                border: "0.5px solid var(--line-2)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Icon name="info" size={12} style={{ color: "var(--text-3)" }} />
              {lutId === "none"
                ? "No color grade. Pick a look (or upload a .cube) to bake a LUT into the exported .mp4."
                : "Baked into the exported file on render — the editor preview stays ungraded."}
            </div>
          </div>
        )}

        {/* File name */}
        <div>
          <div className="mono cap" style={{ color: "var(--text-1)", marginBottom: 8 }}>
            File name
          </div>
          <Input
            value={fileName}
            onChange={setFileName}
            mono
            suffix={`.${ext}`}
          />
        </div>

        {/* States */}
        {(status === "idle" || status === "error") && (
          <>
            {status === "error" && (
              <div style={{ fontSize: 12, color: "var(--red)" }}>{error}</div>
            )}
            <Button variant="primary" size="lg" full icon="download" onClick={handleExport} disabled={!code.trim()}>
              Export
            </Button>
          </>
        )}

        {(status === "queued" || status === "rendering") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="mono cap" style={{ color: "var(--text-1)" }}>
                {status === "queued" ? "Queued..." : "Rendering"}
              </span>
              <span className="mono nums" style={{ fontSize: 12, color: "var(--accent)" }}>
                {Math.min(100, Math.round(progress))}%
              </span>
            </div>
            <div style={{ height: 6, background: "var(--bg-inset)", borderRadius: 3, overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.min(100, progress)}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, var(--accent), oklch(0.92 0.22 124))",
                  transition: "width 100ms linear",
                  boxShadow: "0 0 12px oklch(0.88 0.22 124 / 0.5)",
                }}
              />
            </div>
            <div className="mono nums" style={{ fontSize: 11, color: "var(--text-3)" }}>
              frame {Math.round((progress / 100) * durationInFrames)} / {durationInFrames}
            </div>
          </div>
        )}

        {confirmingClose && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 12,
              background: "var(--bg-inset)",
              border: "0.5px solid var(--accent-line)",
              borderRadius: "var(--r-sm)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>Export is still rendering</div>
            <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
              It keeps running in the background and downloads automatically when it&apos;s done.
              You can reopen Export any time to check progress — the render never stops.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="outline" size="sm" onClick={() => setConfirmingClose(false)}>
                Keep watching
              </Button>
              <Button variant="primary" size="sm" onClick={closeKeepingRender}>
                Close (keep rendering)
              </Button>
            </div>
          </div>
        )}

        {cacheStats && cacheStats.count > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingTop: 10,
              borderTop: "0.5px solid var(--line-1)",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            <Icon name="info" size={12} />
            <span className="mono">
              {cacheStats.count} cached render{cacheStats.count === 1 ? "" : "s"} ·{" "}
              {formatBytes(cacheStats.totalBytes)}
            </span>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={handleClearRenders} disabled={cleaning}>
              {cleaning ? "Clearing..." : "Clear cache"}
            </Button>
          </div>
        )}

        {status === "done" && downloadUrl && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: 12,
                background: "var(--accent-soft)",
                border: "0.5px solid var(--accent-line)",
                borderRadius: "var(--r-sm)",
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  background: "var(--accent)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon name="check" size={14} style={{ color: "var(--accent-ink)" }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Render complete</div>
                <div className="mono nums" style={{ fontSize: 11, color: "var(--text-2)" }}>
                  {fileName}.{ext}
                </div>
              </div>
            </div>
            <a
              href={downloadUrl}
              download={`${fileName || "export"}.${ext}`}
              style={{ textDecoration: "none" }}
            >
              <Button variant="primary" size="lg" full icon="download">
                Download file
              </Button>
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}
