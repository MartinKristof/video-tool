"use client";

/* eslint-disable react-hooks/set-state-in-effect -- loading flags are deliberately set on effect entry to track async lifecycle */

import React, { useEffect, useState } from "react";
import Modal from "@/components/ui/Modal";
import Icon from "@/components/ui/Icon";
import type { CutPlan } from "@/lib/cut-plan";

interface MediaFile {
  name: string;
  path: string;
  type: "video" | "audio" | "image" | "other";
  size: number;
  sizeFormatted: string;
}

interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

interface Transcript {
  text: string;
  language: string;
  words: TranscriptWord[];
  durationSeconds: number;
}

// The real plan type, not a local copy of it — this now crosses a boundary into
// docFromCutPlan, and the copy had already drifted (no `thresholds`).

interface SmartTrimDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  fps: number;
  hasMediaFolder: boolean;
  hasExistingCode: boolean;
  /**
   * The plan comes back alongside the code so the caller can land the cut on the
   * TIMELINE (one clip per kept range) rather than as a generated <Series>. The
   * code stays in the payload as the fallback for a plan with no ranges.
   */
  onApply: (result: { code?: string; plan: CutPlan; mediaSrc: string; name: string }) => void;
}

type Stage = "pick" | "transcribing" | "review" | "error";

const MODELS: { value: string; label: string; hint: string }[] = [
  { value: "tiny.en", label: "Tiny", hint: "~5s/min, decent" },
  { value: "small.en", label: "Small", hint: "~30s/min, good" },
  { value: "medium.en", label: "Medium", hint: "~2min/min, best" },
];

export default function SmartTrimDialog({
  open,
  onClose,
  projectId,
  fps,
  hasMediaFolder,
  hasExistingCode,
  onApply,
}: SmartTrimDialogProps) {
  const [stage, setStage] = useState<Stage>("pick");
  const [error, setError] = useState<string | null>(null);

  const [files, setFiles] = useState<MediaFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<MediaFile | null>(null);
  const [model, setModel] = useState("small.en");

  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [plan, setPlan] = useState<CutPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  // Threshold controls (re-planned client-side)
  const [maxGap, setMaxGap] = useState(0.6);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [padding, setPadding] = useState(0.05);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setStage("pick");
    setError(null);
    setSelectedFile(null);
    setTranscript(null);
    setPlan(null);
    setConfirmReplace(false);
  }, [open]);

  // Fetch media files when entering pick stage
  useEffect(() => {
    if (!open || !hasMediaFolder || stage !== "pick") return;
    let cancelled = false;
    setFilesLoading(true);
    fetch(`/api/media/${projectId}/list`)
      .then((r) => r.json())
      .then((data: { folder: string; files: MediaFile[] }) => {
        if (cancelled) return;
        const playable = (data.files ?? []).filter(
          (f) => f.type === "video" || f.type === "audio"
        );
        setFiles(playable);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, hasMediaFolder, stage, projectId]);

  // Re-plan whenever transcript or thresholds change
  useEffect(() => {
    if (!transcript) return;
    let cancelled = false;
    setPlanning(true);
    fetch(`/api/cut-plan/${projectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        thresholds: {
          maxGapSeconds: maxGap,
          removeFillers,
          paddingSeconds: padding,
        },
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.ok) setPlan(data.plan);
        else setError(data.error ?? "Plan failed");
      })
      .finally(() => {
        if (!cancelled) setPlanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transcript, maxGap, removeFillers, padding, projectId]);

  async function startTranscribe(file: MediaFile) {
    setSelectedFile(file);
    setStage("transcribing");
    setError(null);
    try {
      const res = await fetch(`/api/transcribe/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaFile: file.path, model }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Transcription failed");
        setStage("error");
        return;
      }
      setTranscript(data.transcript);
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setStage("error");
    }
  }

  async function applyPlan() {
    if (!transcript || !plan || !selectedFile) return;
    if (hasExistingCode && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    const res = await fetch(`/api/cut-plan/${projectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        thresholds: {
          maxGapSeconds: maxGap,
          removeFillers,
          paddingSeconds: padding,
        },
        generate: {
          mediaSrc: `/api/media/${projectId}/${selectedFile.path}`,
          fps,
        },
      }),
    });
    const data = await res.json();
    if (!data.ok || !data.plan) {
      setError(data.error ?? "Code generation failed");
      setStage("error");
      return;
    }
    onApply({
      code: data.code,
      plan: data.plan,
      mediaSrc: `/api/media/${projectId}/${selectedFile.path}`,
      name: selectedFile.path,
    });
    onClose();
  }

  const removedPct = plan
    ? Math.round(((plan.originalDuration - plan.trimmedDuration) / Math.max(plan.originalDuration, 0.001)) * 100)
    : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title="Smart trim"
      stepLabel="Transcribe → cut silences → emit a Remotion composition"
    >
      <div className="vt-scroll" style={{ overflowY: "auto", maxHeight: 560 }}>
        {!hasMediaFolder && (
          <div style={{ padding: 24, fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
            This project has no <code className="mono">mediaFolder</code> configured. Set one
            via the new-project flow, then come back.
          </div>
        )}

        {hasMediaFolder && stage === "pick" && (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div className="mono cap" style={{ color: "var(--text-1)", marginBottom: 8 }}>
                Whisper model
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {MODELS.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => setModel(m.value)}
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 2,
                      background:
                        model === m.value ? "var(--accent-soft)" : "var(--bg-inset)",
                      border: `0.5px solid ${
                        model === m.value ? "var(--accent)" : "var(--line-2)"
                      }`,
                      borderRadius: "var(--r-sm)",
                      cursor: "pointer",
                      color: "var(--text-0)",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{m.label}</span>
                    <span style={{ fontSize: 10, color: "var(--text-3)" }}>{m.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div
                className="mono cap"
                style={{ color: "var(--text-1)", marginBottom: 8, display: "flex", gap: 8 }}
              >
                <span>Source media</span>
                <span style={{ color: "var(--text-3)" }}>
                  {filesLoading ? "loading…" : `${files.length} file${files.length === 1 ? "" : "s"}`}
                </span>
              </div>
              {files.length === 0 && !filesLoading ? (
                <div style={{ padding: 18, fontSize: 11, color: "var(--text-3)", textAlign: "center" }}>
                  No video or audio in mediaFolder.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => startTranscribe(f)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        background: "var(--bg-inset)",
                        border: "0.5px solid var(--line-2)",
                        borderRadius: "var(--r-sm)",
                        cursor: "pointer",
                        color: "var(--text-0)",
                        textAlign: "left",
                        transition: "border-color 120ms",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--accent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--line-2)";
                      }}
                    >
                      <Icon
                        name={f.type === "video" ? "film" : "monitor"}
                        size={13}
                        style={{ color: "var(--text-2)" }}
                      />
                      <span className="mono" style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.path}
                      </span>
                      <span className="mono nums" style={{ fontSize: 10, color: "var(--text-3)" }}>
                        {f.sizeFormatted}
                      </span>
                      <Icon name="arrowRight" size={12} style={{ color: "var(--text-3)" }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {stage === "transcribing" && (
          <div
            style={{
              padding: 60,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              color: "var(--text-1)",
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                border: "2.5px solid var(--accent)",
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <div style={{ fontSize: 13, fontWeight: 600 }}>Transcribing {selectedFile?.name}…</div>
            <div style={{ fontSize: 11, color: "var(--text-2)", textAlign: "center", maxWidth: 380 }}>
              Whisper runs locally — first call downloads the {model} model (~75 MB for tiny, ~500 MB for small). Cached after that.
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {stage === "review" && plan && transcript && (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            {/* Stats */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 10,
              }}
            >
              <Stat label="Original" value={`${plan.originalDuration.toFixed(1)}s`} />
              <Stat
                label="Trimmed"
                value={`${plan.trimmedDuration.toFixed(1)}s`}
                accent="var(--accent)"
              />
              <Stat label="Removed" value={`${removedPct}%`} accent="var(--magenta)" />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 10,
              }}
            >
              <Stat label="Words" value={String(transcript.words.length)} />
              <Stat
                label="Keep ranges"
                value={String(plan.ranges.length)}
              />
              <Stat
                label="Cuts"
                value={String(plan.removed.length)}
              />
            </div>

            {/* Thresholds */}
            <div>
              <div className="mono cap" style={{ color: "var(--text-1)", marginBottom: 10 }}>
                Thresholds
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <SliderRow
                  label="Max silence"
                  value={maxGap}
                  min={0.1}
                  max={2.0}
                  step={0.05}
                  format={(v) => `${(v * 1000).toFixed(0)}ms`}
                  onChange={setMaxGap}
                />
                <SliderRow
                  label="Padding"
                  value={padding}
                  min={0}
                  max={0.5}
                  step={0.01}
                  format={(v) => `${(v * 1000).toFixed(0)}ms`}
                  onChange={setPadding}
                />
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={removeFillers}
                    onChange={(e) => setRemoveFillers(e.target.checked)}
                  />
                  <span style={{ color: "var(--text-1)" }}>
                    Remove filler words (um, uh, you know, like…)
                  </span>
                </label>
              </div>
            </div>

            {/* Removed preview */}
            {plan.removed.length > 0 && (
              <details>
                <summary
                  style={{
                    fontSize: 11,
                    color: "var(--text-2)",
                    cursor: "pointer",
                    padding: "4px 0",
                  }}
                >
                  Show {plan.removed.length} removed segment{plan.removed.length === 1 ? "" : "s"}
                </summary>
                <div
                  style={{
                    marginTop: 8,
                    maxHeight: 160,
                    overflow: "auto",
                    background: "var(--bg-inset)",
                    border: "0.5px solid var(--line-2)",
                    borderRadius: "var(--r-sm)",
                    padding: 8,
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--text-2)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {plan.removed
                    .filter(
                      (r) =>
                        typeof r?.from === "number" &&
                        typeof r?.to === "number" &&
                        Number.isFinite(r.from) &&
                        Number.isFinite(r.to)
                    )
                    .map((r, i) => (
                      <div key={i} style={{ display: "flex", gap: 10 }}>
                        <span
                          style={{
                            width: 56,
                            color:
                              r.reason === "filler" ? "var(--magenta)" : "var(--text-3)",
                          }}
                        >
                          {r.reason}
                        </span>
                        <span className="nums" style={{ width: 110, color: "var(--text-3)" }}>
                          {r.from.toFixed(2)}s – {r.to.toFixed(2)}s
                        </span>
                        <span style={{ color: "var(--text-1)", flex: 1 }}>{r.text ?? "—"}</span>
                      </div>
                    ))}
                </div>
              </details>
            )}

            {planning && (
              <div className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
                replanning…
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setStage("pick")}
                style={{
                  height: 32,
                  padding: "0 14px",
                  background: "var(--bg-3)",
                  color: "var(--text-1)",
                  border: "0.5px solid var(--line-2)",
                  borderRadius: "var(--r-sm)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Pick different file
              </button>
              <div style={{ flex: 1 }} />
              <button
                onClick={applyPlan}
                disabled={plan.ranges.length === 0}
                style={{
                  height: 32,
                  padding: "0 16px",
                  background: "var(--accent)",
                  color: "var(--accent-ink)",
                  border: "none",
                  borderRadius: "var(--r-sm)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: plan.ranges.length === 0 ? "default" : "pointer",
                  opacity: plan.ranges.length === 0 ? 0.4 : 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="sparkle" size={11} />
                Apply trim
              </button>
            </div>
          </div>
        )}

        {stage === "error" && error && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
            <div
              style={{
                color: "var(--red)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                whiteSpace: "pre-wrap",
                background: "rgba(255,0,0,0.06)",
                border: "0.5px solid var(--red)",
                borderRadius: 4,
                padding: 12,
                maxHeight: 280,
                overflow: "auto",
              }}
            >
              {error}
            </div>
            <button
              onClick={() => setStage("pick")}
              style={{
                alignSelf: "flex-start",
                height: 30,
                padding: "0 14px",
                background: "var(--bg-3)",
                color: "var(--text-1)",
                border: "0.5px solid var(--line-2)",
                borderRadius: "var(--r-sm)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Confirm replace overlay */}
      {confirmReplace && (
        <div
          onClick={() => setConfirmReplace(false)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 10,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 380,
              width: "100%",
              background: "var(--bg-2)",
              border: "0.5px solid var(--line-2)",
              borderRadius: "var(--r-md)",
              padding: 22,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>Replace existing code?</div>
            <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
              The auto-generated trim composition will replace what&rsquo;s currently in the editor. Cmd+Z to undo.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmReplace(false)}
                style={{
                  height: 30,
                  padding: "0 14px",
                  background: "var(--bg-3)",
                  color: "var(--text-1)",
                  border: "0.5px solid var(--line-2)",
                  borderRadius: "var(--r-sm)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={applyPlan}
                style={{
                  height: 30,
                  padding: "0 14px",
                  background: "var(--accent)",
                  color: "var(--accent-ink)",
                  border: "none",
                  borderRadius: "var(--r-sm)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg-inset)",
        border: "0.5px solid var(--line-2)",
        borderRadius: "var(--r-sm)",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span className="mono cap" style={{ fontSize: 9, color: "var(--text-3)" }}>
        {label}
      </span>
      <span
        className="mono nums"
        style={{ fontSize: 16, fontWeight: 600, color: accent ?? "var(--text-0)" }}
      >
        {value}
      </span>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span style={{ color: "var(--text-1)" }}>{label}</span>
        <span className="mono nums" style={{ color: "var(--text-2)" }}>
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "var(--accent)" }}
      />
    </div>
  );
}
