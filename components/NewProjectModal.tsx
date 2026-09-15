"use client";

import React, { useState, useEffect, useRef } from "react";
import { STYLE_MODES } from "@/lib/prompts/styles";
import { TRANSITION_MODES } from "@/lib/prompts/transitions";
import type { AnimationType, Engine, Resolution, Orientation, FPS, SvgFile, StyleMode, TopicCardStyle, TransitionStyle, Collection } from "@/lib/types";
import { getAnimationTypeMeta, normalizeAnimationType } from "@/lib/animation-types";
import { emptyDoc } from "@/lib/editor-doc";
import { getProjectSize } from "@/lib/types";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";
import Input from "@/components/ui/Input";
import Textarea from "@/components/ui/Textarea";
import Segmented from "@/components/ui/Segmented";
import TypeTile from "@/components/TypeTile";
import SnippetParamsForm from "@/components/SnippetParamsForm";
import { SNIPPET_SCHEMAS, buildDefaultValues } from "@/lib/snippet-schemas";
import { SNIPPET_ICONS } from "@/lib/snippet-icons";
import { renderSnippet } from "@/lib/snippet-template";
import StylePreviewModal from "@/components/StylePreviewModal";

interface SnippetSummary {
  id: string;
  name: string;
  subtitle: string;
  code: string;
}

type VideoMode = "smarttrim" | "compose" | "manual";

interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  initialType?: AnimationType;
  // Called when the project is created and all media (if any) has finished
  // uploading. The parent is responsible for navigating to the new project.
  onCreated: (result: { projectId: string; autoAction?: "smarttrim" | "compose" }) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "creating-project" }
  | {
      kind: "uploading";
      fileIndex: number;
      fileName: string;
      fileSize: number;
      bytesUploadedTotal: number;
      totalBytes: number;
    }
  | { kind: "error"; message: string };

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function uploadFileWithProgress(
  projectId: string,
  file: File,
  onProgress: (bytesLoaded: number) => void,
  registerXhr: (xhr: XMLHttpRequest) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    registerXhr(xhr);
    const url = `/api/media/${projectId}/upload?name=${encodeURIComponent(file.name)}`;
    console.log("[upload] starting", { name: file.name, size: file.size, url });
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onloadstart = () => {
      console.log("[upload] loadstart", file.name);
      // Tell the caller we've started even before bytes leave so the UI moves.
      onProgress(0);
    };
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.upload.onerror = () => {
      console.error("[upload] upload.onerror", file.name);
    };
    xhr.upload.onabort = () => {
      console.warn("[upload] upload.onabort", file.name);
    };
    xhr.onload = () => {
      console.log("[upload] onload", file.name, xhr.status);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else
        reject(
          new Error(
            `Upload failed (HTTP ${xhr.status})${xhr.responseText ? `: ${xhr.responseText}` : ""}`
          )
        );
    };
    xhr.onerror = () => {
      console.error("[upload] onerror", file.name);
      reject(new Error("Network error during upload (server may have crashed)"));
    };
    xhr.onabort = () => {
      console.warn("[upload] onabort", file.name);
      reject(new Error("Upload aborted"));
    };
    xhr.ontimeout = () => {
      console.error("[upload] ontimeout", file.name);
      reject(new Error("Upload timed out"));
    };
    xhr.send(file);
  });
}

const SNIPPET_ACCENT: Record<string, string> = {
  IntroCard: "#FF64B8",
  LowerThird: "#20A34E",
  EndCard: "#246DFF",
  StatCallout: "#F86606",
  QuoteCard: "#9D829F",
  LogoBumper: "#FF64B8",
  CalloutBanner: "#246DFF",
  ListReveal: "#20A34E",
  CodeSnippet: "#7DD3FC",
  SymbolBug: "#F86606",
};

function OrientationPreview({ ratio, active }: { ratio: string; active: boolean }) {
  const dims =
    ratio === "16:9" ? { w: 36, h: 20 } : ratio === "9:16" ? { w: 20, h: 36 } : { w: 28, h: 28 };
  return (
    <div
      style={{
        width: dims.w,
        height: dims.h,
        background: active ? "var(--accent)" : "var(--bg-3)",
        border: `0.5px solid ${active ? "var(--accent)" : "var(--line-3)"}`,
        borderRadius: 3,
      }}
    />
  );
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
      <span className="mono cap" style={{ color: "var(--text-1)" }}>
        {children}
      </span>
      {hint && (
        <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export default function NewProjectModal({ open, onClose, initialType, onCreated }: NewProjectModalProps) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [resolution, setResolution] = useState<Resolution>("4k");
  const [fps, setFps] = useState<FPS>(25);
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  // "broll" is still a valid stored value, but new projects are "animation" —
  // the two generate from an identical prompt (see normalizeAnimationType).
  const [animationType, setAnimationType] = useState<AnimationType>(
    initialType ? normalizeAnimationType(initialType) : "animation",
  );
  // Remotion is the only engine; kept explicit because it is stored on the
  // project and sent to the generate/render routes.
  const engine: Engine = "remotion";
  const typeLocked = initialType !== undefined;
  const typeMeta = getAnimationTypeMeta(animationType);

  const [prompt, setPrompt] = useState("");
  const [notionUrl, setNotionUrl] = useState("");
  const [notionContent, setNotionContent] = useState<string | undefined>();
  const [notionLoading, setNotionLoading] = useState(false);
  // Video projects: editable editorial-notes box. Fetch fills it; the user can
  // also type/paste directly. Its content becomes the project's notionContent.
  const [notesText, setNotesText] = useState("");
  const [scriptWithTimestamps, setScriptWithTimestamps] = useState("");

  const [svgFiles, setSvgFiles] = useState<SvgFile[]>([]);
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const currentXhrRef = useRef<XMLHttpRequest | null>(null);
  const creating = phase.kind === "creating-project" || phase.kind === "uploading";
  // Diagnostics so we can tell whether the file-input onChange ever fires.
  const [pickEvents, setPickEvents] = useState(0);
  const [lastPickStatus, setLastPickStatus] = useState<string>("");

  const [snippets, setSnippets] = useState<SnippetSummary[]>([]);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  const [snippetValues, setSnippetValues] = useState<Record<string, unknown>>({});
  const [videoMode, setVideoMode] = useState<VideoMode>("smarttrim");
  const [dragActive, setDragActive] = useState(false);
  const [styleMode, setStyleMode] = useState<StyleMode>("default");
  const [topicCardStyle, setTopicCardStyle] = useState<TopicCardStyle>("cards");
  const [transitionStyle, setTransitionStyle] = useState<TransitionStyle>("cut");
  const [stylePreviewOpen, setStylePreviewOpen] = useState(false);
  const [useSfx, setUseSfx] = useState(true);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState<string>("");

  // Load collections so the user can file the new project into one at creation.
  useEffect(() => {
    if (!open) return;
    fetch("/api/collections")
      .then((r) => r.json())
      .then(setCollections)
      .catch(() => setCollections([]));
  }, [open]);

  // Reset the params form whenever the user picks a different snippet — each
  // snippet has its own schema and defaults.
  useEffect(() => {
    if (!selectedSnippetId) {
      setSnippetValues({});
      return;
    }
    const schema = SNIPPET_SCHEMAS[selectedSnippetId];
    if (schema) setSnippetValues(buildDefaultValues(schema));
  }, [selectedSnippetId]);

  useEffect(() => {
    if (open) {
      setStep(1);
      setSelectedSnippetId(null);
      setVideoMode("smarttrim");
      if (initialType) setAnimationType(initialType);
    }
  }, [open, initialType]);

  // Fetch snippets once when the modal first opens.
  useEffect(() => {
    if (!open || snippets.length > 0) return;
    let cancelled = false;
    fetch("/api/snippets")
      .then((r) => r.json())
      .then((data: SnippetSummary[]) => {
        if (!cancelled) setSnippets(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, snippets.length]);

  function handleClose() {
    // Abort any in-flight upload so the user can't leave one half-running.
    if (currentXhrRef.current) {
      try {
        currentXhrRef.current.abort();
      } catch {}
      currentXhrRef.current = null;
    }
    setStep(1);
    setName("");
    setPrompt("");
    setNotionUrl("");
    setNotionContent(undefined);
    setNotesText("");
    setScriptWithTimestamps("");
    setSvgFiles([]);
    setMediaFiles([]);
    setSelectedSnippetId(null);
    setSnippetValues({});
    setVideoMode("smarttrim");
    setPhase({ kind: "idle" });
    setPickEvents(0);
    setLastPickStatus("");
    onClose();
  }

  async function fetchNotion() {
    if (!notionUrl.trim()) return;
    setNotionLoading(true);
    try {
      const res = await fetch("/api/notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: notionUrl.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setNotionContent(data.content);
        // Drop the fetched content into the editable notes box (append so any
        // notes the user already typed aren't lost).
        if (data.content) {
          setNotesText((prev) => [prev.trim(), data.content].filter(Boolean).join("\n\n"));
        }
      }
    } catch {
      // ignore
    } finally {
      setNotionLoading(false);
    }
  }

  const selectedSnippet = selectedSnippetId
    ? snippets.find((s) => s.id === selectedSnippetId) ?? null
    : null;

  const isVideo = animationType === "video";
  const isSmartTrim = isVideo && videoMode === "smarttrim";

  function canCreate(): boolean {
    if (isSmartTrim) return mediaFiles.length > 0;
    if (isVideo) return mediaFiles.length > 0 || prompt.trim().length > 0;
    if (selectedSnippet) return true;
    return prompt.trim().length > 0;
  }

  async function handleCreate() {
    if (!canCreate()) return;
    console.log("[create] start", {
      name: name.trim(),
      animationType,
      mediaFiles: mediaFiles.map((f) => ({ name: f.name, size: f.size })),
    });
    // Immediately surface the overlay so the user sees something is happening,
    // even before the project create POST resolves.
    setPhase({ kind: "creating-project" });

    // Compose assembles onto a TIMELINE. Creating the document with the project
    // (rather than after mount) is what makes the handoff work: useImperativeHandle
    // re-binds during commit, before the effect that starts the first pass, so
    // ChatPanel's runWithPrompt sees the document and routes to /api/edit-doc.
    // Created client-side instead, it would still be closed over `undefined` and
    // the first pass would quietly write a TSX file.
    //
    // Smart trim gets none: it builds its own document from the cut plan.
    const composeSettings = { resolution, orientation, fps };
    // "manual" gets one too: the whole point is to land on a timeline with the
    // footage ready and nothing done to it yet.
    const startsAsTimeline = isVideo && (videoMode === "compose" || videoMode === "manual");
    const projectBody = {
      name: name.trim(),
      animationType,
      engine,
      settings: composeSettings,
      ...(startsAsTimeline
        ? { doc: emptyDoc({ ...getProjectSize(composeSettings), fps }) }
        : {}),
      initialPrompt: isSmartTrim
        ? prompt.trim() || "Smart trim recording"
        : selectedSnippet
          ? prompt.trim() || `Started from ${selectedSnippet.name}`
          : isVideo
            ? // Video projects build via Analyze → chat, so a prompt is optional.
              // Fall back to a label so the API's (initialPrompt||initialCode) check passes.
              prompt.trim() || "Edit uploaded footage"
            : prompt.trim(),
      initialCode: selectedSnippet
        ? (() => {
            const schema = SNIPPET_SCHEMAS[selectedSnippet.id];
            if (!schema || Object.keys(schema.params).length === 0) return selectedSnippet.code;
            return renderSnippet(selectedSnippet.code, schema, snippetValues);
          })()
        : undefined,
      // Video uses the editable notes box (which Fetch fills from Notion); other
      // types keep the fetched-Notion content as-is.
      notionContent: isVideo ? notesText.trim() || undefined : notionContent,
      scriptWithTimestamps: scriptWithTimestamps.trim() || undefined,
      svgContents: svgFiles.length > 0 ? svgFiles : undefined,
      styleMode: animationType === "terminal" || isVideo ? undefined : styleMode,
      topicCardStyle: isVideo ? topicCardStyle : undefined,
      transitionStyle: animationType === "terminal" || isVideo ? undefined : transitionStyle,
      useSfx: animationType === "terminal" ? false : useSfx,
      collectionId: collectionId || undefined,
    };

    try {
      console.log("[create] POST /api/projects");
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectBody),
      });
      console.log("[create] /api/projects status", res.status);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setPhase({
          kind: "error",
          message: `Failed to create project (HTTP ${res.status})${text ? `: ${text}` : ""}`,
        });
        return;
      }
      const project = await res.json();
      console.log("[create] project created", project.id);

      if (mediaFiles.length > 0) {
        const totalBytes = mediaFiles.reduce((s, f) => s + f.size, 0);
        let cumulative = 0;
        for (let i = 0; i < mediaFiles.length; i++) {
          const file = mediaFiles[i];
          const baseCumulative = cumulative;
          setPhase({
            kind: "uploading",
            fileIndex: i,
            fileName: file.name,
            fileSize: file.size,
            bytesUploadedTotal: baseCumulative,
            totalBytes,
          });
          await uploadFileWithProgress(
            project.id,
            file,
            (loaded) => {
              setPhase({
                kind: "uploading",
                fileIndex: i,
                fileName: file.name,
                fileSize: file.size,
                bytesUploadedTotal: baseCumulative + loaded,
                totalBytes,
              });
            },
            (xhr) => {
              currentXhrRef.current = xhr;
            }
          );
          currentXhrRef.current = null;
          cumulative += file.size;
        }
      }

      console.log("[create] done");
      // For video projects, hand the chosen first-pass mode to the project page,
      // which runs the whole first pass (analyze → smart-trim/compose) with a
      // visible progress panel.
      onCreated({
        projectId: project.id,
        // "manual" deliberately has no first pass — the timeline opens with the
        // footage imported and untouched.
        autoAction: isVideo && videoMode !== "manual" ? videoMode : undefined,
      });
    } catch (err) {
      console.error("[create] failed", err);
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  function cancelUpload() {
    if (currentXhrRef.current) {
      try {
        currentXhrRef.current.abort();
      } catch {}
      currentXhrRef.current = null;
    }
    setPhase({ kind: "idle" });
  }

  const showSnippetPicker =
    animationType !== "terminal" && animationType !== "video";

  const ratioForOrientation = (o: Orientation) =>
    o === "horizontal" ? "16:9" : o === "vertical" ? "9:16" : "1:1";

  return (
    <>
    <Modal
      open={open}
      onClose={handleClose}
      width={560}
      title={
        step === 1
          ? typeLocked
            ? `New ${typeMeta.label} project`
            : "New project"
          : animationType === "terminal" ? "Describe the recording" : "Describe the animation"
      }
      stepLabel={`Step ${step} of 2`}
    >
      {/* Step progress bar */}
      <div style={{ display: "flex", gap: 6, padding: "0 20px 16px" }}>
        <div style={{ flex: 1, height: 3, background: "var(--accent)", borderRadius: 2 }} />
        <div
          style={{
            flex: 1,
            height: 3,
            background: step === 2 ? "var(--accent)" : "var(--bg-3)",
            borderRadius: 2,
            transition: "background 200ms",
          }}
        />
      </div>

      <div className="vt-scroll" style={{ overflowY: "auto" }}>
        {step === 1 && (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <FieldLabel>Project name</FieldLabel>
              <Input
                value={name}
                onChange={setName}
                placeholder="e.g. Product Launch Teaser"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) {
                    e.preventDefault();
                    setStep(2);
                  }
                }}
              />
            </div>

            <div>
              <FieldLabel hint="Optional — group several projects for one video">Collection</FieldLabel>
              <select
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
                className="mono"
                style={{
                  width: "100%",
                  height: 34,
                  padding: "0 10px",
                  background: "var(--bg-inset)",
                  border: "0.5px solid var(--line-2)",
                  borderRadius: "var(--r-sm)",
                  color: "var(--text-0)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <option value="">None</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {!typeLocked && (
              <div>
                <FieldLabel>Type</FieldLabel>
                <div style={{ display: "flex", gap: 8 }}>
                  {(["animation", "svg", "video"] as AnimationType[]).map((t) => (
                    <TypeTile
                      key={t}
                      type={t}
                      active={animationType === t}
                      onClick={() => setAnimationType(t)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1 }}>
                <FieldLabel>Resolution</FieldLabel>
                <Segmented
                  value={resolution}
                  onChange={(v) => setResolution(v as Resolution)}
                  options={[
                    { value: "4k", label: "4K" },
                    { value: "1080p", label: "1080p" },
                  ]}
                />
              </div>
              <div style={{ flex: 2 }}>
                <FieldLabel>FPS</FieldLabel>
                <Segmented
                  value={fps}
                  onChange={(v) => setFps(v as FPS)}
                  options={[
                    { value: 24, label: "24" },
                    { value: 25, label: "25" },
                    { value: 30, label: "30" },
                    { value: 50, label: "50" },
                  ]}
                />
              </div>
            </div>

            <div>
              <FieldLabel>Orientation</FieldLabel>
              <div style={{ display: "flex", gap: 8 }}>
                {(
                  [
                    { o: "horizontal" as Orientation, label: "Horizontal", sub: "16 : 9" },
                    { o: "vertical" as Orientation, label: "Vertical", sub: "9 : 16" },
                    { o: "square" as Orientation, label: "Square", sub: "1 : 1" },
                  ] as const
                ).map(({ o, label, sub }) => {
                  const active = orientation === o;
                  return (
                    <button
                      key={o}
                      onClick={() => setOrientation(o)}
                      style={{
                        flex: 1,
                        height: 92,
                        padding: 10,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                        background: active ? "var(--accent-soft)" : "var(--bg-inset)",
                        border: `0.5px solid ${active ? "var(--accent)" : "var(--line-2)"}`,
                        borderRadius: "var(--r-md)",
                        cursor: "pointer",
                        color: "var(--text-0)",
                        transition: "all 120ms",
                      }}
                    >
                      <div style={{ height: 40, display: "grid", placeItems: "center" }}>
                        <OrientationPreview ratio={ratioForOrientation(o)} active={active} />
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 1,
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
                        <span className="mono" style={{ fontSize: 10, color: "var(--text-2)" }}>
                          {sub}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ paddingTop: 4 }}>
              <Button
                variant="primary"
                size="lg"
                full
                onClick={() => {
                  if (name.trim()) setStep(2);
                }}
                disabled={!name.trim()}
              >
                Next &middot; Content <Icon name="arrowRight" size={14} />
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            {isVideo && (
              <div>
                <FieldLabel hint="How should we build your starting cut?">
                  First pass
                </FieldLabel>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <ModeCard
                    active={videoMode === "smarttrim"}
                    accent="#FF64B8"
                    icon="sparkle"
                    title="Smart trim"
                    subtitle="Auto-cut the dead air — silences + filler words drop out"
                    onClick={() => setVideoMode("smarttrim")}
                  />
                  <ModeCard
                    active={videoMode === "compose"}
                    accent="#246DFF"
                    icon="code"
                    title="Compose"
                    subtitle="The AI edits from your footage + notes"
                    onClick={() => setVideoMode("compose")}
                  />
                  <ModeCard
                    active={videoMode === "manual"}
                    accent="#6CD99A"
                    icon="film"
                    title="I'll cut it"
                    subtitle="Open a timeline with your footage and nothing done to it"
                    onClick={() => setVideoMode("manual")}
                  />
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10, color: "var(--text-3)", marginTop: 8 }}
                >
                  {videoMode === "manual"
                    ? "Your footage is imported and the timeline opens empty. Smart trim and Compose stay available from Tools whenever you want them."
                    : "After you create, we analyze the footage and build this first cut automatically — then you refine it by chatting."}
                </div>
              </div>
            )}

            {showSnippetPicker && snippets.length > 0 && (
              <div>
                <FieldLabel hint="Skip the AI prompt and start from a finished scene">
                  Start from a brand snippet
                </FieldLabel>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 8,
                  }}
                >
                  <button
                    onClick={() => setSelectedSnippetId(null)}
                    style={{
                      padding: "10px 12px",
                      minHeight: 64,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 4,
                      background:
                        selectedSnippetId === null ? "var(--accent-soft)" : "var(--bg-inset)",
                      border: `0.5px solid ${
                        selectedSnippetId === null ? "var(--accent)" : "var(--line-2)"
                      }`,
                      borderRadius: "var(--r-sm)",
                      cursor: "pointer",
                      textAlign: "left",
                      color: "var(--text-0)",
                      transition: "all 120ms",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Icon name="sparkle" size={11} style={{ color: "var(--accent)" }} />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>AI prompt</span>
                    </div>
                    <span style={{ fontSize: 10, color: "var(--text-2)" }}>
                      Describe it, AI generates
                    </span>
                  </button>
                  {snippets.map((s) => {
                    const accent = SNIPPET_ACCENT[s.id] ?? "var(--accent)";
                    const icon = SNIPPET_ICONS[s.id] ?? "film";
                    const active = selectedSnippetId === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedSnippetId(s.id)}
                        style={{
                          padding: "10px 12px",
                          minHeight: 64,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: 4,
                          background: active
                            ? `color-mix(in oklab, ${accent} 14%, transparent)`
                            : "var(--bg-inset)",
                          border: `0.5px solid ${active ? accent : "var(--line-2)"}`,
                          borderRadius: "var(--r-sm)",
                          cursor: "pointer",
                          textAlign: "left",
                          color: "var(--text-0)",
                          transition: "all 120ms",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <Icon name={icon} size={11} style={{ color: accent }} />
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</span>
                        </div>
                        <span style={{ fontSize: 10, color: "var(--text-2)", lineHeight: 1.3 }}>
                          {s.subtitle}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedSnippet && (() => {
              const schema = SNIPPET_SCHEMAS[selectedSnippet.id];
              if (!schema || Object.keys(schema.params).length === 0) return null;
              return (
                <div>
                  <FieldLabel hint="Fill in the values — the snippet is generated deterministically from your inputs">
                    Snippet parameters
                  </FieldLabel>
                  <div
                    style={{
                      padding: 14,
                      background: "var(--bg-inset)",
                      border: "0.5px solid var(--line-2)",
                      borderRadius: "var(--r-sm)",
                    }}
                  >
                    <SnippetParamsForm
                      schema={schema}
                      values={snippetValues}
                      onValuesChange={setSnippetValues}
                      hideFooter
                    />
                  </div>
                </div>
              );
            })()}

            {!isSmartTrim && !isVideo && animationType !== "terminal" && (
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <FieldLabel hint="Visual style for the AI — kinetic/editorial/cinematic produce noticeably different looks">
                    Style
                  </FieldLabel>
                  <button
                    type="button"
                    onClick={() => setStylePreviewOpen(true)}
                    title="Preview the styles"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      marginBottom: 8,
                      padding: "2px 8px",
                      fontSize: 10,
                      color: "var(--text-2)",
                      background: "var(--bg-inset)",
                      border: "0.5px solid var(--line-2)",
                      borderRadius: "var(--r-sm)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="info" size={11} />
                    Preview
                  </button>
                </div>
                <Segmented
                  value={styleMode}
                  onChange={(v) => setStyleMode(v as StyleMode)}
                  options={STYLE_MODES.map((m) => ({ label: m.label, value: m.id }))}
                />
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 6 }}>
                  {STYLE_MODES.find((m) => m.id === styleMode)?.description}
                </div>
              </div>
            )}

            {!isSmartTrim && !isVideo && animationType !== "terminal" && (
              <div>
                <FieldLabel hint="How scenes hand off — cut (clean), blend (soft), or camera (a dolly push). The background stays continuous in all three.">
                  Transition style
                </FieldLabel>
                <Segmented
                  value={transitionStyle}
                  onChange={(v) => setTransitionStyle(v as TransitionStyle)}
                  options={TRANSITION_MODES.map((m) => ({ label: m.label, value: m.id }))}
                />
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 6 }}>
                  {TRANSITION_MODES.find((m) => m.id === transitionStyle)?.description}
                </div>
              </div>
            )}

            {animationType !== "terminal" && (
              <div>
                <FieldLabel hint="Let the AI add tasteful whooshes / pops / impacts where they fit">
                  Sound effects
                </FieldLabel>
                <Segmented
                  value={useSfx ? "on" : "off"}
                  onChange={(v) => setUseSfx(v === "on")}
                  options={[
                    { label: "On", value: "on" },
                    { label: "Off", value: "off" },
                  ]}
                />
              </div>
            )}

            {/* Video projects have a single input — the Editorial notes box below —
                so notes/instructions can't be split across two fields (the trap
                where notes silently land in the wrong one). Non-video keeps its
                generate prompt. */}
            {!isSmartTrim && !isVideo && (
              <div>
                <FieldLabel
                  hint={
                    selectedSnippet
                      ? "Optional — refine after creation via chat"
                      : animationType === "terminal"
                        ? "Describe the command(s), timing, and style"
                        : "What should the AI generate?"
                  }
                >
                  {animationType === "terminal" ? "Terminal script prompt" : "Prompt"}
                </FieldLabel>
                <Textarea
                  value={prompt}
                  onChange={setPrompt}
                  rows={selectedSnippet ? 3 : 5}
                  placeholder={
                    selectedSnippet
                      ? `${selectedSnippet.name} loaded — leave blank or note any tweaks…`
                      : animationType === "terminal"
                        ? `e.g. "Type 'apify actors search instagram', press Enter, show results, 8 seconds total. Dark theme, large font."`
                        : "Describe the animation you want..."
                  }
                  style={undefined}
                  onKeyDown={(e) => {
                    // Enter creates; Shift+Enter inserts a newline.
                    if (e.key === "Enter" && !e.shiftKey && canCreate() && !creating) {
                      e.preventDefault();
                      handleCreate();
                    }
                  }}
                />
              </div>
            )}

            {isVideo && (
              <div
                style={{
                  padding: 12,
                  background: "var(--accent-soft)",
                  border: "0.5px solid var(--accent)",
                  borderRadius: "var(--r-sm)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-1)",
                  lineHeight: 1.5,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon name="sparkle" size={12} style={{ color: "var(--accent)" }} />
                  <span style={{ fontWeight: 600, color: "var(--text-0)" }}>
                    What happens next
                  </span>
                </div>
                <div style={{ color: "var(--text-2)" }}>
                  {isSmartTrim
                    ? "On create we analyze your footage (transcript + scene cuts, and auto-reframe if the timeline aspect differs), then auto-cut the silences + filler words into a first cut. You'll see the progress, then land on the edit to refine."
                    : "On create we analyze your footage (transcript + scene cuts, and auto-reframe if the timeline aspect differs), then the AI builds a first cut from your notes. You'll see the progress, then land on the edit to refine."}
                </div>
              </div>
            )}

            {animationType === "svg" && (
              <div>
                <FieldLabel hint={`${svgFiles.length} file${svgFiles.length === 1 ? "" : "s"}`}>
                  SVG assets
                </FieldLabel>
                <div
                  style={{
                    padding: 12,
                    background: "var(--bg-inset)",
                    border: "0.5px dashed var(--line-2)",
                    borderRadius: "var(--r-sm)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  {svgFiles.length >= 2 && (() => {
                    const viewBoxes = svgFiles.map((s) => {
                      const m = s.content.match(/viewBox="([\d.\-\s]+)"/);
                      return m ? m[1].trim().replace(/\s+/g, " ") : null;
                    });
                    const allMatch = viewBoxes.every((v) => v !== null && v === viewBoxes[0]);
                    if (!allMatch) return null;
                    return (
                      <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.4 }}>
                        Detected animation sequence — Claude will animate the deltas between frames.
                      </div>
                    );
                  })()}
                  {svgFiles.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {svgFiles.map((svg, i) => (
                        <div
                          key={i}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "4px 6px 4px 10px",
                            height: 26,
                            background: "var(--bg-3)",
                            border: "0.5px solid var(--line-2)",
                            borderRadius: 4,
                          }}
                        >
                          <Icon name="image" size={11} style={{ color: "var(--text-2)" }} />
                          <span className="mono" style={{ fontSize: 11 }}>
                            {svg.filename}
                          </span>
                          <span className="mono nums" style={{ fontSize: 10, color: "var(--text-3)" }}>
                            {svg.content.length.toLocaleString()}ch
                          </span>
                          <button
                            onClick={() => setSvgFiles(svgFiles.filter((_, j) => j !== i))}
                            style={{
                              width: 16,
                              height: 16,
                              border: "none",
                              background: "transparent",
                              color: "var(--text-2)",
                              cursor: "pointer",
                              display: "grid",
                              placeItems: "center",
                              borderRadius: 3,
                            }}
                          >
                            <Icon name="close" size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <label
                    style={{
                      height: 28,
                      border: "0.5px dashed var(--line-3)",
                      background: "transparent",
                      color: "var(--text-1)",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 11,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    + Add SVG
                    <input
                      type="file"
                      accept=".svg"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const files = e.target.files;
                        if (!files || files.length === 0) return;
                        const newFiles: SvgFile[] = [];
                        let remaining = files.length;
                        for (let i = 0; i < files.length; i++) {
                          const file = files[i];
                          const reader = new FileReader();
                          reader.onload = () => {
                            newFiles.push({ filename: file.name, content: reader.result as string });
                            remaining--;
                            if (remaining === 0) {
                              setSvgFiles((prev) => [...prev, ...newFiles]);
                            }
                          };
                          reader.readAsText(file);
                        }
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>
            )}

            {animationType === "video" && (
              <div>
                <FieldLabel
                  hint={`${mediaFiles.length} file${mediaFiles.length === 1 ? "" : "s"}`}
                >
                  Media files
                </FieldLabel>
                <div
                  style={{
                    padding: 12,
                    background: "var(--bg-inset)",
                    border: "0.5px dashed var(--line-2)",
                    borderRadius: "var(--r-sm)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  {mediaFiles.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {mediaFiles.map((file, i) => (
                        <div
                          key={i}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "4px 6px 4px 10px",
                            height: 26,
                            background: "var(--bg-3)",
                            border: "0.5px solid var(--line-2)",
                            borderRadius: 4,
                            maxWidth: "100%",
                          }}
                        >
                          <Icon name="film" size={11} style={{ color: "var(--text-2)" }} />
                          <span
                            className="mono"
                            style={{
                              fontSize: 11,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              maxWidth: 200,
                            }}
                          >
                            {file.name}
                          </span>
                          <span
                            className="mono nums"
                            style={{ fontSize: 10, color: "var(--text-3)" }}
                          >
                            {(file.size / (1024 * 1024)).toFixed(1)}MB
                          </span>
                          <button
                            onClick={() =>
                              setMediaFiles(mediaFiles.filter((_, j) => j !== i))
                            }
                            style={{
                              width: 16,
                              height: 16,
                              border: "none",
                              background: "transparent",
                              color: "var(--text-2)",
                              cursor: "pointer",
                              display: "grid",
                              placeItems: "center",
                              borderRadius: 3,
                            }}
                          >
                            <Icon name="close" size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <label
                    onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
                    onDragOver={(e) => { e.preventDefault(); if (!dragActive) setDragActive(true); }}
                    onDragLeave={(e) => {
                      // Only clear when the pointer actually leaves the dropzone.
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragActive(false);
                      const dropped = Array.from(e.dataTransfer.files).filter((f) =>
                        /\.(mp4|mov|webm|mkv|avi|m4v|mp3|wav|m4a|aac|png|jpe?g|webp|gif)$/i.test(f.name)
                      );
                      if (dropped.length) setMediaFiles((prev) => [...prev, ...dropped]);
                    }}
                    style={{
                      minHeight: 72,
                      padding: "14px 12px",
                      border: dragActive ? "1.5px dashed var(--accent)" : "1px dashed var(--line-3)",
                      background: dragActive ? "var(--accent-soft)" : "var(--bg-inset)",
                      color: dragActive ? "var(--accent)" : "var(--text-1)",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      alignItems: "center",
                      justifyContent: "center",
                      textAlign: "center",
                      transition: "background 120ms, border-color 120ms, color 120ms",
                    }}
                  >
                    {dragActive ? "Drop to add" : "＋ Add media"}
                    <span style={{ fontWeight: 400, fontSize: 11, color: dragActive ? "var(--accent)" : "var(--text-3)" }}>
                      {dragActive ? "release the files here" : "drag & drop video files here, or click to browse (select several)"}
                    </span>
                    <input
                      type="file"
                      accept="video/*,audio/*,image/*,.mp4,.mov,.webm,.mkv,.avi,.m4v,.mp3,.wav,.m4a,.aac"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const fileList = e.target.files;
                        console.log("[picker] onChange fired", {
                          fileCount: fileList?.length ?? 0,
                          files: fileList
                            ? Array.from(fileList).map((f) => ({
                                name: f.name,
                                size: f.size,
                                type: f.type,
                              }))
                            : null,
                        });
                        setPickEvents((n) => n + 1);
                        if (!fileList || fileList.length === 0) {
                          setLastPickStatus("Picker fired but no files were selected.");
                          return;
                        }
                        const picked = Array.from(fileList);
                        setLastPickStatus(
                          `Picked ${picked.length} file${picked.length === 1 ? "" : "s"}: ${picked
                            .map((f) => `${f.name} (${(f.size / (1024 * 1024 * 1024)).toFixed(2)} GB)`)
                            .join(", ")}`
                        );
                        setMediaFiles((prev) => {
                          const next = [...prev, ...picked];
                          console.log("[picker] mediaFiles now", next.length, next.map((f) => f.name));
                          return next;
                        });
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                <div
                  className="mono"
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    color: pickEvents > 0 ? "var(--accent)" : "var(--text-3)",
                    lineHeight: 1.4,
                  }}
                >
                  {pickEvents === 0
                    ? "Files upload into the project on create. Large videos take a moment."
                    : `Picker fired ${pickEvents}× · ${mediaFiles.length} file${mediaFiles.length === 1 ? "" : "s"} queued${lastPickStatus ? ` · ${lastPickStatus}` : ""}`}
                </div>
              </div>
            )}

            {animationType === "video" && (
              <div>
                <FieldLabel hint="Your instructions + notes — the one place the AI reads for the edit">
                  Notes & instructions
                </FieldLabel>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <Input
                    value={notionUrl}
                    onChange={setNotionUrl}
                    placeholder="Paste a Notion link to import…"
                    mono
                    style={{ flex: 1 }}
                  />
                  <Button
                    variant="outline"
                    onClick={fetchNotion}
                    disabled={!notionUrl.trim() || notionLoading}
                  >
                    {notionLoading ? "Fetching…" : "Fetch"}
                  </Button>
                </div>
                <Textarea
                  rows={5}
                  value={notesText}
                  onChange={setNotesText}
                  placeholder={"Everything the AI should follow goes here: what to make (\"a 60s highlight reel\"), plus your KEEP highlights / comments. Or Fetch from a Notion link above."}
                  style={{ fontFamily: "var(--mono)", fontSize: 12 }}
                />
                <div className="mono" style={{ fontSize: 10, color: notesText.trim() ? "var(--accent)" : "var(--text-3)", marginTop: 6, lineHeight: 1.4 }}>
                  {notesText.trim()
                    ? `${notesText.length.toLocaleString()} characters — after you Analyze the video, the AI matches these to the transcript + scene cuts.`
                    : "After you Analyze the video, the AI matches these notes to the transcript + scene cuts."}
                </div>
              </div>
            )}

            {isVideo && (
              <div>
                <FieldLabel hint="How each interview topic is introduced in the edit">
                  Topic labels
                </FieldLabel>
                <Segmented
                  value={topicCardStyle}
                  onChange={(v) => setTopicCardStyle(v as TopicCardStyle)}
                  options={[
                    { value: "cards", label: "Full-screen cards" },
                    { value: "chips", label: "Corner chips" },
                    { value: "none", label: "None" },
                  ]}
                />
                <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginTop: 6, lineHeight: 1.4 }}>
                  {topicCardStyle === "cards"
                    ? "A branded full-screen card wipes in between answers, then cuts to the clip."
                    : topicCardStyle === "chips"
                      ? "A small pill label sits in the corner over the footage."
                      : "No topic labels — just the cuts."}
                </div>
              </div>
            )}

            {animationType === "animation" && (
              <>
                <div>
                  <FieldLabel hint="Optional">Notion URL</FieldLabel>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Input
                      value={notionUrl}
                      onChange={setNotionUrl}
                      placeholder="https://notion.so/..."
                      mono
                      style={{ flex: 1 }}
                    />
                    <Button
                      variant="outline"
                      onClick={fetchNotion}
                      disabled={!notionUrl.trim() || notionLoading}
                    >
                      {notionLoading ? "Fetching..." : "Fetch"}
                    </Button>
                  </div>
                  {notionContent && (
                    <div
                      className="mono"
                      style={{ fontSize: 10, color: "var(--accent)", marginTop: 6 }}
                    >
                      Fetched {notionContent.length.toLocaleString()} characters
                    </div>
                  )}
                </div>

                <div>
                  <FieldLabel hint="Timecodes drive scene pacing">Script with timestamps</FieldLabel>
                  <Textarea
                    rows={4}
                    value={scriptWithTimestamps}
                    onChange={setScriptWithTimestamps}
                    placeholder={"[00:00] Cold open on the hero surface\n[00:03] Logo reveal, subtle glow\n[00:06] Pan across the UI..."}
                    style={{ fontFamily: "var(--mono)", fontSize: 12 }}
                  />
                </div>
              </>
            )}

            <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
              <Button variant="outline" onClick={() => setStep(1)} icon="arrowLeft">
                Back
              </Button>
              <div style={{ flex: 1 }} />
              <Button
                variant="primary"
                size="lg"
                onClick={handleCreate}
                disabled={!canCreate() || creating}
                icon={isSmartTrim ? "sparkle" : selectedSnippet ? "layers" : "sparkle"}
              >
                {creating
                  ? "Creating..."
                  : isVideo
                    ? "Create & build first cut"
                    : selectedSnippet
                      ? `Create from ${selectedSnippet.name}`
                      : animationType === "terminal" ? "Create recording" : "Create animation"}
              </Button>
            </div>
          </div>
        )}
      </div>
      {phase.kind !== "idle" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(5,5,8,0.88)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 460,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              background: "var(--bg-2)",
              border: "0.5px solid var(--line-2)",
              borderRadius: "var(--r-lg)",
              padding: 20,
              boxShadow: "var(--sh-float)",
            }}
          >
            {phase.kind === "creating-project" && (
              <>
                <div className="mono cap" style={{ color: "var(--text-2)", fontSize: 10 }}>
                  Setting up project…
                </div>
                <div style={{ fontSize: 14, color: "var(--text-1)" }}>
                  Creating the project on the server. The upload starts right after.
                </div>
                <div
                  style={{
                    height: 6,
                    width: "100%",
                    background: "var(--bg-3)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: "30%",
                      background: "var(--accent)",
                      animation: "vt-indeterminate 1.4s ease-in-out infinite",
                    }}
                  />
                </div>
              </>
            )}

            {phase.kind === "uploading" && (
              <>
                <div className="mono cap" style={{ color: "var(--text-2)", fontSize: 10 }}>
                  Uploading media · {phase.fileIndex + 1} of {mediaFiles.length}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text-0)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={phase.fileName}
                >
                  {phase.fileName}
                </div>
                <div
                  style={{
                    height: 6,
                    width: "100%",
                    background: "var(--bg-3)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(
                        100,
                        (phase.bytesUploadedTotal / Math.max(1, phase.totalBytes)) * 100
                      ).toFixed(1)}%`,
                      background: "var(--accent)",
                      transition: "width 120ms linear",
                    }}
                  />
                </div>
                <div
                  className="mono nums"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    color: "var(--text-2)",
                  }}
                >
                  <span>
                    {formatBytes(phase.bytesUploadedTotal)} / {formatBytes(phase.totalBytes)}
                  </span>
                  <span>
                    {(
                      (phase.bytesUploadedTotal / Math.max(1, phase.totalBytes)) *
                      100
                    ).toFixed(0)}
                    %
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.4 }}>
                  Large files take a while — feel free to grab a coffee. Don&apos;t close this tab.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <Button variant="outline" onClick={cancelUpload}>
                    Cancel
                  </Button>
                </div>
              </>
            )}

            {phase.kind === "error" && (
              <>
                <div
                  className="mono cap"
                  style={{ color: "var(--danger, #ff5252)", fontSize: 10 }}
                >
                  Upload failed
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-0)",
                    wordBreak: "break-word",
                  }}
                >
                  {phase.message}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.4 }}>
                  Open the browser DevTools console for diagnostic logs prefixed with{" "}
                  <code className="mono">[upload]</code> / <code className="mono">[create]</code>.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <Button variant="outline" onClick={() => setPhase({ kind: "idle" })}>
                    Dismiss
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
    <StylePreviewModal
      open={stylePreviewOpen}
      onClose={() => setStylePreviewOpen(false)}
      selected={styleMode}
      onSelect={(m) => setStyleMode(m)}
    />
    </>
  );
}

function ModeCard({
  active,
  accent,
  icon,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  accent: string;
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "12px 14px",
        minHeight: 86,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 6,
        background: active
          ? `color-mix(in oklab, ${accent} 14%, transparent)`
          : "var(--bg-inset)",
        border: `0.5px solid ${active ? accent : "var(--line-2)"}`,
        borderRadius: "var(--r-sm)",
        cursor: "pointer",
        textAlign: "left",
        color: "var(--text-0)",
        transition: "all 120ms",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name={icon} size={12} style={{ color: accent }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      </div>
      <span style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.35 }}>
        {subtitle}
      </span>
    </button>
  );
}
