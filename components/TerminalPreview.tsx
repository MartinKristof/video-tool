"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import Icon from "@/components/ui/Icon";
import TapeExamplesPicker from "@/components/TapeExamplesPicker";
import TerminalTimeline from "@/components/TerminalTimeline";
import { Player, type PlayerRef } from "@remotion/player";
import TerminalRecording, {
  END_CARD_FRAMES,
  terminalTotalFrames,
  normalizeRectToCompAspect,
} from "@/remotion/scenes/terminal/TerminalRecording";
import type {
  TerminalAnnotations,
  TerminalZoom,
  TerminalBanner,
  TerminalEndCard,
  TerminalFreeze,
} from "@/lib/types";

interface TerminalPreviewProps {
  projectId: string;
  code: string;
  onReplaceCode?: (next: string) => void;
  annotations?: TerminalAnnotations;
  onAnnotationsChange?: (next: TerminalAnnotations | undefined) => void;
  customTheme?: boolean;
  onCustomThemeChange?: (next: boolean) => void;
}

interface ProbeResult {
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
}

interface RenderResult {
  ok: boolean;
  outPath?: string;
  error?: string;
  bytes?: number;
  stderr?: string;
  probe?: ProbeResult | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function emptyAnnotations(probe: ProbeResult): TerminalAnnotations {
  const fps = Math.max(1, Math.round(probe.frameRate));
  return {
    videoDurationFrames: Math.max(1, Math.round(probe.durationSeconds * fps)),
    videoWidth: probe.width,
    videoHeight: probe.height,
    fps,
    zooms: [],
  };
}

function canUsePlayer(a?: TerminalAnnotations): boolean {
  if (!a) return false;
  return a.videoWidth > 0 && a.videoHeight > 0 && a.videoDurationFrames > 0;
}

export default function TerminalPreview({
  projectId,
  code,
  onReplaceCode,
  annotations,
  onAnnotationsChange,
  customTheme,
  onCustomThemeChange,
}: TerminalPreviewProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stderr, setStderr] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [endCardOpen, setEndCardOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<PlayerRef>(null);
  const playerBoxRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const useAnnotated = canUsePlayer(annotations);
  const fps = annotations?.fps ?? 30;
  const compWidth = annotations?.videoWidth || 1200;
  const compHeight = annotations?.videoHeight || 600;

  // Size the box to the largest rect that preserves the composition aspect
  // ratio AND fits within the available area. CSS `aspect-ratio` alone won't
  // do this reliably when both width and height are constrained.
  useEffect(() => {
    if (!useAnnotated) return;
    const container = playerContainerRef.current;
    if (!container) return;
    const targetRatio = compWidth / compHeight;
    const update = () => {
      const r = container.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const containerRatio = r.width / r.height;
      if (containerRatio > targetRatio) {
        setBoxSize({ w: Math.round(r.height * targetRatio), h: Math.round(r.height) });
      } else {
        setBoxSize({ w: Math.round(r.width), h: Math.round(r.width / targetRatio) });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => ro.disconnect();
  }, [useAnnotated, compWidth, compHeight]);
  const totalFrames = annotations ? terminalTotalFrames(annotations) : 1;

  // Hydrate annotations from probe data when the recording exists but we
  // don't have stored metadata yet.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/vhs/${projectId}/render`)
      .then((r) => r.json())
      .then(
        (data: {
          exists: boolean;
          mtimeMs?: number;
          bytes?: number;
          probe?: ProbeResult | null;
        }) => {
          if (cancelled || !data.exists) return;
          setSrc(`/api/vhs/${projectId}/output?ts=${data.mtimeMs}`);
          if (typeof data.bytes === "number") setBytes(data.bytes);
          if (data.probe && !annotations && onAnnotationsChange) {
            onAnnotationsChange(emptyAnnotations(data.probe));
          }
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Poll player for current frame in annotate UI
  useEffect(() => {
    if (!useAnnotated) return;
    let raf = 0;
    const tick = () => {
      const f = playerRef.current?.getCurrentFrame();
      if (typeof f === "number") setCurrentFrame(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [useAnnotated]);

  async function render() {
    setRendering(true);
    setError(null);
    setStderr(null);
    const t0 = performance.now();
    try {
      const res = await fetch(`/api/vhs/${projectId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tape: code }),
      });
      const data = (await res.json()) as RenderResult;
      const elapsed = performance.now() - t0;
      if (!data.ok) {
        setError(data.error ?? "Render failed");
        setRenderMs(null);
      } else {
        setSrc(data.outPath ?? null);
        setStderr(data.stderr ?? null);
        setBytes(data.bytes ?? null);
        setRenderMs(elapsed);
        if (data.probe && onAnnotationsChange) {
          // Keep existing zoom/banner/endCard but refresh dims + duration.
          const fpsNext = Math.max(1, Math.round(data.probe.frameRate));
          const durationFrames = Math.max(
            1,
            Math.round(data.probe.durationSeconds * fpsNext),
          );
          onAnnotationsChange({
            ...emptyAnnotations(data.probe),
            zooms: annotations?.zooms ?? [],
            banner: annotations?.banner,
            endCard: annotations?.endCard,
            videoDurationFrames: durationFrames,
            videoWidth: data.probe.width,
            videoHeight: data.probe.height,
            fps: fpsNext,
          });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setRenderMs(null);
    } finally {
      setRendering(false);
    }
  }

  const playerInputProps = React.useMemo(
    () =>
      annotations && src
        ? {
            videoSrc: src,
            annotations: {
              videoDurationFrames: annotations.videoDurationFrames,
              zooms: annotations.zooms,
              freezes: annotations.freezes,
              banner: annotations.banner,
              endCard: annotations.endCard,
            },
          }
        : null,
    [annotations, src],
  );

  // Refs hold the latest values for use inside capture-phase native listeners,
  // which are attached once per draw-mode session and would otherwise see
  // stale closures.
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const drawRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const saveZoomRef = useRef<((rect: { x: number; y: number; w: number; h: number }) => void) | null>(null);

  const saveZoom = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      if (!annotations || !onAnnotationsChange) return;
      if (rect.w < 0.02 || rect.h < 0.02) return;
      const start = Math.max(0, Math.round(currentFrame));
      const holdFrames = Math.max(15, Math.round(fps * 2));
      const end = Math.min(annotations.videoDurationFrames - 1, start + holdFrames);
      const zoom: TerminalZoom = {
        id: uid(),
        startFrame: start,
        endFrame: end,
        rect,
      };
      onAnnotationsChange({
        ...annotations,
        zooms: [...annotations.zooms, zoom].sort((a, b) => a.startFrame - b.startFrame),
      });
    },
    [annotations, onAnnotationsChange, currentFrame, fps],
  );

  useEffect(() => {
    saveZoomRef.current = saveZoom;
  }, [saveZoom]);

  // Click → move cursor → click pattern.
  // 1st mousedown:  records start corner.
  // mousemove:       updates the rect under the cursor.
  // 2nd mousedown:   commits the rect as a zoom and exits draw mode.
  // ESC:             cancels.
  useEffect(() => {
    if (!drawMode) return;
    const box = playerBoxRef.current;
    if (!box) return;

    drawStartRef.current = null;
    drawRectRef.current = null;
    setDrawRect(null);
    playerRef.current?.pause();

    const ptFromEvent = (e: MouseEvent) => {
      const r = box.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
    };

    const finish = () => {
      drawStartRef.current = null;
      drawRectRef.current = null;
      setDrawRect(null);
      setDrawMode(false);
    };

    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const p = ptFromEvent(e);
      if (!drawStartRef.current) {
        drawStartRef.current = p;
        drawRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
        setDrawRect(drawRectRef.current);
      } else {
        const rect = drawRectRef.current;
        if (rect) saveZoomRef.current?.(rect);
        finish();
      }
    };

    const onMove = (e: MouseEvent) => {
      const s = drawStartRef.current;
      if (!s) return;
      const p = ptFromEvent(e);
      const rect = {
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      };
      drawRectRef.current = rect;
      setDrawRect(rect);
    };

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    };

    box.addEventListener("mousedown", onDown, true);
    box.addEventListener("pointerdown", onDown as EventListener, true);
    box.addEventListener("mousemove", onMove, true);
    box.addEventListener("click", onClick, true);
    box.addEventListener("dragstart", onClick, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      box.removeEventListener("mousedown", onDown, true);
      box.removeEventListener("pointerdown", onDown as EventListener, true);
      box.removeEventListener("mousemove", onMove, true);
      box.removeEventListener("click", onClick, true);
      box.removeEventListener("dragstart", onClick, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [drawMode]);

  const deleteZoom = (id: string) => {
    if (!annotations || !onAnnotationsChange) return;
    onAnnotationsChange({
      ...annotations,
      zooms: annotations.zooms.filter((z) => z.id !== id),
    });
  };

  const updateZoom = (id: string, partial: Partial<TerminalZoom>) => {
    if (!annotations || !onAnnotationsChange) return;
    onAnnotationsChange({
      ...annotations,
      zooms: annotations.zooms
        .map((z) => (z.id === id ? { ...z, ...partial } : z))
        .sort((a, b) => a.startFrame - b.startFrame),
    });
  };

  const addFreezeAtPlayhead = () => {
    if (!annotations || !onAnnotationsChange) return;
    const at = Math.max(0, Math.round(currentFrame));
    const dur = Math.max(15, Math.round(fps * 1));
    const freeze: TerminalFreeze = {
      id: uid(),
      atCompFrame: at,
      durationFrames: dur,
    };
    const next = [...(annotations.freezes ?? []), freeze].sort((a, b) => a.atCompFrame - b.atCompFrame);
    onAnnotationsChange({ ...annotations, freezes: next });
  };

  const deleteFreeze = (id: string) => {
    if (!annotations || !onAnnotationsChange) return;
    onAnnotationsChange({
      ...annotations,
      freezes: (annotations.freezes ?? []).filter((f) => f.id !== id),
    });
  };

  const updateFreeze = (id: string, partial: Partial<TerminalFreeze>) => {
    if (!annotations || !onAnnotationsChange) return;
    onAnnotationsChange({
      ...annotations,
      freezes: (annotations.freezes ?? [])
        .map((f) => (f.id === id ? { ...f, ...partial } : f))
        .sort((a, b) => a.atCompFrame - b.atCompFrame),
    });
  };

  const setBanner = (b: TerminalBanner | undefined) => {
    if (!annotations || !onAnnotationsChange) return;
    onAnnotationsChange({ ...annotations, banner: b });
  };

  const setEndCard = (c: TerminalEndCard | undefined) => {
    if (!annotations || !onAnnotationsChange) return;
    onAnnotationsChange({ ...annotations, endCard: c });
  };

  const canAnnotate = !!annotations && !!src;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#000",
        position: "relative",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(8px)",
          borderBottom: "0.5px solid var(--line-1)",
          zIndex: 2,
        }}
      >
        <Icon name="code" size={13} style={{ color: "var(--cyan)" }} />
        <span
          className="mono cap"
          style={{ fontSize: 10, color: "var(--text-1)", letterSpacing: "0.05em" }}
        >
          VHS Terminal
        </span>

        {src && bytes != null && !rendering && !error && (
          <div
            className="mono nums"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              fontSize: 10,
              color: "var(--text-2)",
              background: "var(--bg-3)",
              border: "0.5px solid var(--line-2)",
              borderRadius: 3,
            }}
          >
            <span style={{ color: "var(--accent)" }}>●</span>
            {formatBytes(bytes)}
            {renderMs != null && <span>· {(renderMs / 1000).toFixed(1)}s</span>}
            {annotations && (
              <span>
                · {annotations.videoWidth}×{annotations.videoHeight} @ {annotations.fps}fps
              </span>
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {onCustomThemeChange && (
          <button
            onClick={() => onCustomThemeChange(!customTheme)}
            title={
              customTheme
                ? "Custom theme is ON — AI will preserve your Set Theme line."
                : "Click to enable custom theme. While off, AI forces the Apify default theme."
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 10px",
              height: 26,
              background: customTheme ? "var(--accent)" : "var(--bg-3)",
              color: customTheme ? "var(--accent-ink)" : "var(--text-1)",
              border: customTheme ? "none" : "0.5px solid var(--line-2)",
              borderRadius: "var(--r-sm)",
              fontSize: 11,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Icon name="sparkle" size={11} />
            {customTheme ? "Custom theme" : "Brand theme"}
          </button>
        )}

        {onReplaceCode && (
          <button
            onClick={() => setExamplesOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 10px",
              height: 26,
              background: "var(--bg-3)",
              color: "var(--text-1)",
              border: "0.5px solid var(--line-2)",
              borderRadius: "var(--r-sm)",
              fontSize: 11,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Icon name="layers" size={11} />
            Examples
          </button>
        )}

        <button
          onClick={render}
          disabled={rendering || !code.trim()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 12px",
            height: 26,
            background: rendering ? "var(--bg-3)" : "var(--accent)",
            color: rendering ? "var(--text-2)" : "var(--accent-ink)",
            border: "none",
            borderRadius: "var(--r-sm)",
            fontSize: 11,
            fontWeight: 600,
            cursor: rendering || !code.trim() ? "default" : "pointer",
            opacity: !code.trim() ? 0.5 : 1,
          }}
        >
          {rendering ? (
            <>
              <div
                style={{
                  width: 10,
                  height: 10,
                  border: "1.5px solid currentColor",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              Rendering…
            </>
          ) : (
            <>
              <Icon name="play" size={11} />
              {src ? "Re-render" : "Render"}
            </>
          )}
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: 16,
          position: "relative",
        }}
      >
        <div
          ref={playerContainerRef}
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {src && !error ? (
            useAnnotated && playerInputProps ? (
              <div
                ref={playerBoxRef}
                style={{
                  position: "relative",
                  width: boxSize.w || undefined,
                  height: boxSize.h || undefined,
                  isolation: "isolate",
                }}
              >
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    pointerEvents: drawMode ? "none" : "auto",
                  }}
                >
                  <Player
                    ref={playerRef}
                    component={TerminalRecording}
                    inputProps={playerInputProps}
                    durationInFrames={totalFrames}
                    fps={fps}
                    compositionWidth={compWidth}
                    compositionHeight={compHeight}
                    controls={!drawMode}
                    clickToPlay={!drawMode}
                    doubleClickToFullscreen={false}
                    spaceKeyToPlayOrPause={!drawMode}
                    loop
                    style={{ width: "100%", height: "100%" }}
                  />
                </div>
                {drawMode && (
                  <div
                    onDragStart={(e) => e.preventDefault()}
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(0,0,0,0.25)",
                      border: "1px dashed var(--accent)",
                      cursor: "crosshair",
                      zIndex: 100,
                      userSelect: "none",
                      pointerEvents: "auto",
                    }}
                  >
                    {!drawRect && (
                      <div
                        style={{
                          position: "absolute",
                          top: 12,
                          left: 12,
                          padding: "4px 8px",
                          fontSize: 11,
                          fontWeight: 600,
                          background: "var(--accent)",
                          color: "var(--accent-ink)",
                          borderRadius: 4,
                          pointerEvents: "none",
                        }}
                      >
                        Click a corner · move · click again to save (Esc to cancel)
                      </div>
                    )}
                    {drawRect && (() => {
                      const norm = normalizeRectToCompAspect(drawRect);
                      const expanded = Math.abs(norm.w - drawRect.w) > 0.005 || Math.abs(norm.h - drawRect.h) > 0.005;
                      return (
                        <>
                          {/* User's draw rectangle (what they actually dragged). */}
                          <div
                            style={{
                              position: "absolute",
                              left: `${drawRect.x * 100}%`,
                              top: `${drawRect.y * 100}%`,
                              width: `${drawRect.w * 100}%`,
                              height: `${drawRect.h * 100}%`,
                              border: "1px dashed rgba(255,255,255,0.5)",
                              pointerEvents: "none",
                            }}
                          />
                          {/* Ghost: the rect actually zoomed into (squared to comp aspect). */}
                          <div
                            style={{
                              position: "absolute",
                              left: `${norm.x * 100}%`,
                              top: `${norm.y * 100}%`,
                              width: `${norm.w * 100}%`,
                              height: `${norm.h * 100}%`,
                              border: "2px solid var(--accent)",
                              background: "rgba(255,100,184,0.18)",
                              pointerEvents: "none",
                            }}
                          />
                          {expanded && drawRect.w > 0.02 && drawRect.h > 0.02 && (
                            <div
                              className="mono"
                              style={{
                                position: "absolute",
                                left: `${norm.x * 100}%`,
                                top: `calc(${(norm.y + norm.h) * 100}% + 4px)`,
                                padding: "2px 6px",
                                fontSize: 10,
                                color: "var(--accent-ink)",
                                background: "var(--accent)",
                                borderRadius: 3,
                                whiteSpace: "nowrap",
                                pointerEvents: "none",
                              }}
                            >
                              Expanded to match composition aspect
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            ) : (
              <video
                ref={videoRef}
                key={src}
                src={src}
                controls
                autoPlay
                loop
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  borderRadius: 4,
                  boxShadow: "0 0 40px rgba(0,0,0,0.8)",
                }}
              />
            )
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 14,
                color: "var(--text-2)",
                fontSize: 12,
                textAlign: "center",
                maxWidth: 460,
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: "var(--bg-3)",
                  border: "0.5px solid var(--line-2)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-3)",
                }}
              >
                <Icon name="film" size={20} />
              </div>
              {error ? (
                <div
                  style={{
                    color: "var(--red)",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    whiteSpace: "pre-wrap",
                    textAlign: "left",
                    background: "rgba(255,0,0,0.06)",
                    border: "0.5px solid var(--red)",
                    borderRadius: 4,
                    padding: 12,
                    maxHeight: 220,
                    overflow: "auto",
                    width: "100%",
                  }}
                >
                  {error}
                </div>
              ) : (
                <>
                  <div style={{ color: "var(--text-1)", fontWeight: 500 }}>
                    No render yet
                  </div>
                  <div>
                    Click <span style={{ color: "var(--accent)" }}>Render</span> to run the
                    .tape script through vhs and produce out.mp4.
                    {onReplaceCode && (
                      <>
                        {" "}Or pick a starter from{" "}
                        <button
                          onClick={() => setExamplesOpen(true)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--accent)",
                            padding: 0,
                            cursor: "pointer",
                            textDecoration: "underline",
                            font: "inherit",
                          }}
                        >
                          Examples
                        </button>
                        .
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {canAnnotate && (
          <AnnotatorPanel
            code={code}
            annotations={annotations!}
            currentFrame={currentFrame}
            drawMode={drawMode}
            onToggleDrawMode={() => {
              setDrawMode((v) => !v);
              setDrawRect(null);
            }}
            onOpenBanner={() => setBannerOpen(true)}
            onOpenEndCard={() => setEndCardOpen(true)}
            onAddFreeze={addFreezeAtPlayhead}
            onDeleteZoom={deleteZoom}
            onUpdateZoom={updateZoom}
            onDeleteFreeze={deleteFreeze}
            onUpdateFreeze={updateFreeze}
            onRemoveBanner={() => setBanner(undefined)}
            onRemoveEndCard={() => setEndCard(undefined)}
            onUpdateEndCard={(partial) => {
              if (!annotations || !onAnnotationsChange || !annotations.endCard) return;
              onAnnotationsChange({ ...annotations, endCard: { ...annotations.endCard, ...partial } });
            }}
            onSeek={(f) => playerRef.current?.seekTo(f)}
          />
        )}
      </div>

      {bannerOpen && annotations && (
        <BannerEditor
          fps={annotations.fps}
          totalFrames={annotations.videoDurationFrames}
          initial={annotations.banner}
          currentFrame={currentFrame}
          onClose={() => setBannerOpen(false)}
          onSave={(b) => {
            setBanner(b);
            setBannerOpen(false);
          }}
        />
      )}

      {endCardOpen && annotations && (
        <EndCardEditor
          initial={annotations.endCard}
          onClose={() => setEndCardOpen(false)}
          onSave={(c) => {
            setEndCard(c);
            setEndCardOpen(false);
          }}
        />
      )}

      {stderr && !error && (
        <details
          style={{
            position: "absolute",
            bottom: 12,
            left: 12,
            right: 12,
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(8px)",
            border: "0.5px solid var(--line-1)",
            borderRadius: 4,
            fontSize: 10,
            fontFamily: "var(--mono)",
            color: "var(--text-2)",
            maxHeight: 100,
            overflow: "hidden",
          }}
        >
          <summary style={{ padding: "6px 10px", cursor: "pointer" }}>vhs log</summary>
          <pre
            style={{
              margin: 0,
              padding: "0 10px 8px",
              whiteSpace: "pre-wrap",
              maxHeight: 80,
              overflow: "auto",
            }}
          >
            {stderr}
          </pre>
        </details>
      )}

      {onReplaceCode && (
        <TapeExamplesPicker
          open={examplesOpen}
          onClose={() => setExamplesOpen(false)}
          hasExistingCode={code.trim().length > 0}
          onUseExample={(source) => {
            onReplaceCode(source);
          }}
        />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ---------- Zoom row (timing + easing controls) ---------- */

const ZOOM_EASING_OPTIONS: { value: "snap" | "smooth" | "linear"; label: string }[] = [
  { value: "snap", label: "Snap" },
  { value: "smooth", label: "Smooth" },
  { value: "linear", label: "Linear" },
];

interface ZoomRowProps {
  zoom: TerminalZoom;
  fps: number;
  videoDurationFrames: number;
  onUpdate: (partial: Partial<TerminalZoom>) => void;
  onDelete: () => void;
}

function ZoomRow({ zoom, fps, videoDurationFrames, onUpdate, onDelete }: ZoomRowProps) {
  const holdFrames = Math.max(1, zoom.endFrame - zoom.startFrame);
  const rampIn = zoom.rampInFrames ?? 8;
  const rampOut = zoom.rampOutFrames ?? 24;
  const easing = zoom.easing ?? "snap";

  const setHold = (frames: number) => {
    const clamped = Math.max(1, Math.min(videoDurationFrames - zoom.startFrame - 1, frames));
    onUpdate({ endFrame: zoom.startFrame + clamped });
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 9,
    color: "var(--text-3)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };

  const inputStyle: React.CSSProperties = {
    width: 44,
    padding: "1px 4px",
    fontSize: 10,
    background: "var(--bg-2)",
    color: "var(--text-1)",
    border: "0.5px solid var(--line-2)",
    borderRadius: 3,
    fontFamily: "var(--mono)",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        background: "var(--bg-3)",
        border: "0.5px solid var(--line-2)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: "var(--text-2)",
        }}
      >
        <span style={{ color: "var(--accent)" }}>●</span>
        <span className="mono nums">
          zoom · {(zoom.startFrame / fps).toFixed(2)}s → {(zoom.endFrame / fps).toFixed(2)}s
        </span>
        <span style={{ color: "var(--text-3)" }}>
          rect {(zoom.rect.w * 100).toFixed(0)}×{(zoom.rect.h * 100).toFixed(0)}%
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onDelete}
          style={{
            padding: "2px 6px",
            fontSize: 10,
            background: "transparent",
            color: "var(--text-3)",
            border: "0.5px solid var(--line-2)",
            borderRadius: 3,
            cursor: "pointer",
          }}
        >
          remove
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={labelStyle}>Hold</span>
          <input
            type="number"
            min={1}
            value={holdFrames}
            onChange={(e) => setHold(Number(e.target.value) || 1)}
            style={inputStyle}
          />
          <span style={{ ...labelStyle, textTransform: "none" }}>frames</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={labelStyle}>Ramp in</span>
          <input
            type="number"
            min={0}
            value={rampIn}
            onChange={(e) => onUpdate({ rampInFrames: Math.max(0, Number(e.target.value) || 0) })}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={labelStyle}>Ramp out</span>
          <input
            type="number"
            min={0}
            value={rampOut}
            onChange={(e) => onUpdate({ rampOutFrames: Math.max(0, Number(e.target.value) || 0) })}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={labelStyle}>Easing</span>
          <select
            value={easing}
            onChange={(e) => onUpdate({ easing: e.target.value as "snap" | "smooth" | "linear" })}
            style={{
              padding: "1px 4px",
              fontSize: 10,
              background: "var(--bg-2)",
              color: "var(--text-1)",
              border: "0.5px solid var(--line-2)",
              borderRadius: 3,
              fontFamily: "var(--mono)",
            }}
          >
            {ZOOM_EASING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

/* ---------- Annotator panel ---------- */

interface AnnotatorPanelProps {
  code: string;
  annotations: TerminalAnnotations;
  currentFrame: number;
  drawMode: boolean;
  onToggleDrawMode: () => void;
  onOpenBanner: () => void;
  onOpenEndCard: () => void;
  onAddFreeze: () => void;
  onDeleteZoom: (id: string) => void;
  onUpdateZoom: (id: string, partial: Partial<TerminalZoom>) => void;
  onDeleteFreeze: (id: string) => void;
  onUpdateFreeze: (id: string, partial: Partial<TerminalFreeze>) => void;
  onRemoveBanner: () => void;
  onRemoveEndCard: () => void;
  onUpdateEndCard: (partial: Partial<TerminalEndCard>) => void;
  onSeek: (frame: number) => void;
}

function AnnotatorPanel({
  code,
  annotations,
  currentFrame,
  drawMode,
  onToggleDrawMode,
  onOpenBanner,
  onOpenEndCard,
  onAddFreeze,
  onDeleteZoom,
  onUpdateZoom,
  onDeleteFreeze,
  onUpdateFreeze,
  onRemoveBanner,
  onRemoveEndCard,
  onUpdateEndCard,
  onSeek,
}: AnnotatorPanelProps) {
  const freezes = annotations.freezes ?? [];
  const freezeTotalFrames = freezes.reduce((sum, f) => sum + f.durationFrames, 0);
  const { videoDurationFrames, fps } = annotations;
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        background: "var(--bg-2)",
        border: "0.5px solid var(--line-1)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={onToggleDrawMode}
          style={{
            padding: "5px 10px",
            fontSize: 11,
            fontWeight: 600,
            background: drawMode ? "var(--accent)" : "var(--bg-3)",
            color: drawMode ? "var(--accent-ink)" : "var(--text-1)",
            border: "0.5px solid var(--line-2)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {drawMode ? "Drawing… (click → move → click)" : "+ Zoom"}
        </button>
        <button
          onClick={onOpenBanner}
          style={panelButtonStyle}
        >
          {annotations.banner ? "Edit banner" : "+ Banner"}
        </button>
        <button
          onClick={onAddFreeze}
          style={panelButtonStyle}
        >
          + Freeze
        </button>
        <button
          onClick={onOpenEndCard}
          style={panelButtonStyle}
        >
          {annotations.endCard ? "Edit end card" : "+ End card"}
        </button>
        <div style={{ flex: 1 }} />
        <div
          className="mono nums"
          style={{ fontSize: 10, color: "var(--text-2)" }}
        >
          frame {Math.round(currentFrame)} / {videoDurationFrames + freezeTotalFrames + (annotations.endCard ? END_CARD_FRAMES : 0)}
        </div>
      </div>

      <TerminalTimeline
        code={code}
        annotations={annotations}
        currentFrame={currentFrame}
        onSeek={onSeek}
        onUpdateZoom={onUpdateZoom}
        onUpdateFreeze={onUpdateFreeze}
        onUpdateEndCard={onUpdateEndCard}
      />

      {/* Lists */}
      {annotations.zooms.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {annotations.zooms.map((z) => (
            <ZoomRow
              key={z.id}
              zoom={z}
              fps={fps}
              videoDurationFrames={annotations.videoDurationFrames}
              onUpdate={(partial) => onUpdateZoom(z.id, partial)}
              onDelete={() => onDeleteZoom(z.id)}
            />
          ))}
        </div>
      )}

      {freezes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {freezes.map((f) => (
            <div
              key={f.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: "var(--text-2)",
                padding: "4px 8px",
                background: "var(--bg-3)",
                border: "0.5px solid var(--line-2)",
                borderRadius: 4,
              }}
            >
              <span style={{ color: "#e6c45c" }}>●</span>
              <span className="mono nums">
                freeze · {(f.atCompFrame / fps).toFixed(2)}s for {(f.durationFrames / fps).toFixed(2)}s
              </span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => onDeleteFreeze(f.id)}
                style={{
                  padding: "2px 6px",
                  fontSize: 10,
                  background: "transparent",
                  color: "var(--text-3)",
                  border: "0.5px solid var(--line-2)",
                  borderRadius: 3,
                  cursor: "pointer",
                }}
              >
                remove
              </button>
            </div>
          ))}
        </div>
      )}

      {annotations.banner && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "var(--text-2)",
            padding: "4px 8px",
            background: "var(--bg-3)",
            border: "0.5px solid var(--line-2)",
            borderRadius: 4,
          }}
        >
          <span style={{ color: "#5aa8ff" }}>●</span>
          <span>banner · &quot;{annotations.banner.text}&quot;</span>
          <span className="mono nums" style={{ color: "var(--text-3)" }}>
            {(annotations.banner.startFrame / fps).toFixed(1)}s–{(annotations.banner.endFrame / fps).toFixed(1)}s
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onRemoveBanner}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              background: "transparent",
              color: "var(--text-3)",
              border: "0.5px solid var(--line-2)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            remove
          </button>
        </div>
      )}

      {annotations.endCard && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "var(--text-2)",
            padding: "4px 8px",
            background: "var(--bg-3)",
            border: "0.5px solid var(--line-2)",
            borderRadius: 4,
          }}
        >
          <span style={{ color: "#6cd99a" }}>●</span>
          <span>end card · &quot;{annotations.endCard.title}&quot;</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onRemoveEndCard}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              background: "transparent",
              color: "var(--text-3)",
              border: "0.5px solid var(--line-2)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            remove
          </button>
        </div>
      )}
    </div>
  );
}


const panelButtonStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: 11,
  fontWeight: 500,
  background: "var(--bg-3)",
  color: "var(--text-1)",
  border: "0.5px solid var(--line-2)",
  borderRadius: 4,
  cursor: "pointer",
};

/* ---------- Editors ---------- */

interface BannerEditorProps {
  fps: number;
  totalFrames: number;
  currentFrame: number;
  initial?: TerminalBanner;
  onClose: () => void;
  onSave: (b: TerminalBanner) => void;
}

function BannerEditor({ fps, totalFrames, currentFrame, initial, onClose, onSave }: BannerEditorProps) {
  const [text, setText] = useState(initial?.text ?? "");
  const [subtitle, setSubtitle] = useState(initial?.subtitle ?? "");
  const [startSec, setStartSec] = useState(
    ((initial?.startFrame ?? Math.round(currentFrame)) / fps).toFixed(2),
  );
  const [endSec, setEndSec] = useState(
    ((initial?.endFrame ?? Math.min(totalFrames - 1, Math.round(currentFrame) + fps * 3)) / fps).toFixed(2),
  );

  return (
    <Modal title="Banner" onClose={onClose}>
      <Field label="Text">
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={inputStyle}
        />
      </Field>
      <Field label="Subtitle (optional)">
        <input
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          style={inputStyle}
        />
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Start (s)">
          <input
            value={startSec}
            onChange={(e) => setStartSec(e.target.value)}
            style={inputStyle}
            inputMode="decimal"
          />
        </Field>
        <Field label="End (s)">
          <input
            value={endSec}
            onChange={(e) => setEndSec(e.target.value)}
            style={inputStyle}
            inputMode="decimal"
          />
        </Field>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button onClick={onClose} style={panelButtonStyle}>Cancel</button>
        <button
          onClick={() => {
            const sf = Math.max(0, Math.min(totalFrames - 1, Math.round(parseFloat(startSec) * fps)));
            const ef = Math.max(sf + 1, Math.min(totalFrames - 1, Math.round(parseFloat(endSec) * fps)));
            if (!text.trim()) return;
            onSave({
              text: text.trim(),
              subtitle: subtitle.trim() || undefined,
              startFrame: sf,
              endFrame: ef,
            });
          }}
          style={{ ...panelButtonStyle, background: "var(--accent)", color: "var(--accent-ink)", fontWeight: 600 }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

interface EndCardEditorProps {
  initial?: TerminalEndCard;
  onClose: () => void;
  onSave: (c: TerminalEndCard) => void;
}

function EndCardEditor({ initial, onClose, onSave }: EndCardEditorProps) {
  const [title, setTitle] = useState(initial?.title ?? "Try it free");
  const [subtitle, setSubtitle] = useState(initial?.subtitle ?? "");
  const [url, setUrl] = useState(initial?.url ?? "apify.com");

  return (
    <Modal title="End card" onClose={onClose}>
      <Field label="Title">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={inputStyle}
        />
      </Field>
      <Field label="Subtitle (optional)">
        <input
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          style={inputStyle}
        />
      </Field>
      <Field label="URL (optional)">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={inputStyle}
        />
      </Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button onClick={onClose} style={panelButtonStyle}>Cancel</button>
        <button
          onClick={() => {
            if (!title.trim()) return;
            onSave({
              title: title.trim(),
              subtitle: subtitle.trim() || undefined,
              url: url.trim() || undefined,
            });
          }}
          style={{ ...panelButtonStyle, background: "var(--accent)", color: "var(--accent-ink)", fontWeight: 600 }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-2)",
          border: "0.5px solid var(--line-1)",
          borderRadius: 8,
          padding: 18,
          minWidth: 360,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
      <span style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: "0.05em" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: 12,
  background: "var(--bg-3)",
  color: "var(--text-1)",
  border: "0.5px solid var(--line-2)",
  borderRadius: 4,
  fontFamily: "var(--mono)",
};
