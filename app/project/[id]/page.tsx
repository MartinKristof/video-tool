"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import GeneratingOverlay from "@/components/GeneratingOverlay";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import ChatPanel, { type ChatPanelHandle } from "@/components/ChatPanel";
import AssetBrowser from "@/components/AssetBrowser";
import SnippetBrowser from "@/components/SnippetBrowser";
import SmartTrimDialog from "@/components/SmartTrimDialog";
import AnalyzeDialog from "@/components/AnalyzeDialog";
import FirstPassProgress, { type FirstPassState } from "@/components/FirstPassProgress";
import ExportDialog from "@/components/ExportDialog";
import TerminalPreview from "@/components/TerminalPreview";
import ConvertAspectRatioButton from "@/components/ConvertAspectRatioButton";
import Timeline from "@/components/Timeline";
import { evalSceneCode } from "@/remotion/DynamicScene";
import { parseSceneMeta } from "@/lib/hyperframes/template";
import type { Project, ChatMessage, TerminalAnnotations, StyleMode, TopicCardStyle, TransitionStyle } from "@/lib/types";
import { getResolution } from "@/lib/types";
import { buildTerminalExportPlan } from "@/lib/terminal-export";
import { stripBackgroundsForTransparency } from "@/lib/transparent-bg";
import Logo from "@/components/ui/Logo";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";
import IconButton from "@/components/ui/IconButton";
import TypeBadge from "@/components/ui/TypeBadge";
import { useCodeHistory } from "@/hooks/useCodeHistory";
import { useDocHistory } from "@/hooks/useDocHistory";
import { docDuration, docFromScene, type EditorDoc } from "@/lib/editor-doc";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { PlayerRef } from "@remotion/player";
import type { ResolvedClip } from "@/lib/timeline-extract";

const EditorPreview = dynamic(() => import("@/components/EditorPreview"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-2)", fontSize: 13 }}>
      Loading preview...
    </div>
  ),
});

const DocTimeline = dynamic(() => import("@/components/DocTimeline"), { ssr: false });

const PreviewPanel = dynamic(() => import("@/components/PreviewPanel"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-2)", fontSize: 13 }}>
      Loading preview...
    </div>
  ),
});

const HyperframesPreview = dynamic(() => import("@/components/HyperframesPreview"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-2)", fontSize: 13 }}>
      Loading preview...
    </div>
  ),
});

const TimelineExtractor = dynamic(() => import("@/components/TimelineExtractor"), { ssr: false });

const CodeEditor = dynamic(() => import("@/components/CodeEditor"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-2)", fontSize: 13 }}>
      Loading editor...
    </div>
  ),
});

export default function ProjectEditor() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [code, setCode] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [terminalAnnotations, setTerminalAnnotations] = useState<TerminalAnnotations | undefined>(undefined);
  const [customTheme, setCustomTheme] = useState<boolean>(false);
  const [styleMode, setStyleMode] = useState<StyleMode>("default");
  const [topicCardStyle, setTopicCardStyle] = useState<TopicCardStyle>("cards");
  const [transitionStyle, setTransitionStyle] = useState<TransitionStyle>("cut");
  const [useSfx, setUseSfx] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [smartTrimOpen, setSmartTrimOpen] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  // Automatic first-pass (analyze → smart-trim/compose) progress, for fresh video projects.
  const [firstPass, setFirstPass] = useState<FirstPassState | null>(null);
  // Video editor "Tools ▾" dropdown (Analyze / Smart trim / Snippets / Assets).
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [bgRemovedFlash, setBgRemovedFlash] = useState(false);
  const [loading, setLoading] = useState(true);
  // Captured once on mount from ?action=, before we clean the URL via router.replace.
  const [initialAutoAction] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("action");
  });

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<{ code: string; chatLength: number; annotations: string; styleMode: StyleMode }>({ code: "", chatLength: 0, annotations: "", styleMode: "default" });
  const codeHistory = useCodeHistory();
  // The editor document. When present it is the source of truth for the video
  // and this project opens in the visual editor instead of the code editor.
  const [doc, setDoc] = useState<EditorDoc | undefined>(undefined);
  const docHistory = useDocHistory();
  const [docMedia, setDocMedia] = useState<{ name: string; path: string; type: string }[]>([]);
  const [docMediaDurations, setDocMediaDurations] = useState<Record<string, number>>({});
  const lastSavedDocRef = useRef<string>("");
  // Which editor is on screen for a project that HAS a document. Purely a view
  // toggle — switching back to code destroys nothing, so trying the editor is
  // never a one-way door.
  const [showCodeEditor, setShowCodeEditor] = useState(false);
  const chatRef = useRef<ChatPanelHandle>(null);
  // Bounds automatic error-retry so a persistently-broken generation can't loop
  // the model forever. Reset to 0 whenever a generation lands with no error.
  const autoRetryRef = useRef(0);

  // Synced playhead: the timeline drives / follows the preview <Player>.
  const playerRef = useRef<PlayerRef | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Native fps + source frame count per media src, so timeline trims convert
  // composition↔source frames and clamp to the footage's real length.
  const [nativeFpsBySrc, setNativeFpsBySrc] = useState<Record<string, number>>({});
  const [maxSrcFrameBySrc, setMaxSrcFrameBySrc] = useState<Record<string, number>>({});
  // Runtime-extracted clip layout (display-only) for compositions the static
  // parsers can't fully see (TransitionSeries, crossfade/data-driven).
  const [resolvedClips, setResolvedClips] = useState<ResolvedClip[] | null>(null);
  // Which model the timeline mapped the composition with; gates the extractor.
  const [timelineMode, setTimelineMode] = useState<"doc" | "data" | "segment" | "none">("none");
  const handleResolved = useCallback((rt: { clips: ResolvedClip[] } | null) => {
    setResolvedClips(rt?.clips ?? null);
  }, []);

  // Load project
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) {
          router.push("/");
          return;
        }
        const data: Project = await res.json();
        setProject(data);
        setCode(data.code);
        setChatHistory(data.chatHistory);
        // Seed version history with the loaded state so the first generation
        // can be undone back to it (code + chat together).
        codeHistory.pushSnapshot(data.code, data.chatHistory);
        if (data.doc) {
          setDoc(data.doc);
          docHistory.pushSnapshot(data.doc);
          lastSavedDocRef.current = JSON.stringify(data.doc);
        }
        setTerminalAnnotations(data.terminalAnnotations);
        setCustomTheme(Boolean(data.customTheme));
        setStyleMode(data.styleMode ?? "default");
        setTopicCardStyle(data.topicCardStyle ?? "cards");
        setTransitionStyle(data.transitionStyle ?? "cut");
        setUseSfx(data.useSfx ?? data.animationType !== "terminal");
        lastSavedRef.current = {
          code: data.code,
          chatLength: data.chatHistory.length,
          annotations: JSON.stringify(data.terminalAnnotations ?? null),
          styleMode: data.styleMode ?? "default",
        };
      } catch {
        router.push("/");
      } finally {
        setLoading(false);
      }
    }
    load();
    // codeHistory is intentionally omitted — the hook returns a fresh object
    // each render, so including it would re-run this loader (and re-fetch) every
    // render. Its methods are stable, so calling pushSnapshot here is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, router]);

  // Honor ?action=smarttrim|compose once: run the automatic first pass
  // (analyze every clip → build the first cut) with a visible progress panel,
  // then clean the URL. Replaces the old "open the Smart Trim dialog" behavior.
  const consumedActionRef = useRef(false);
  useEffect(() => {
    if (consumedActionRef.current) return;
    if (loading || !project) return;
    const action = searchParams.get("action");
    if (action !== "smarttrim" && action !== "compose") return;
    if (project.animationType !== "video") return;
    if (project.code) return; // already built
    consumedActionRef.current = true;
    router.replace(`/project/${projectId}`);
    void runFirstPass(action);
    // runFirstPass is a stable inner fn; deps intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, project, projectId, router, searchParams]);

  // Drive one analyze SSE request, mapping stages to a friendly label.
  async function analyzeOne(mediaFile: string, onStage: (label: string) => void) {
    const res = await fetch(`/api/media/${projectId}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaFile }),
    });
    if (!res.ok || !res.body) throw new Error(`Analyze failed (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        let d: Record<string, unknown>;
        try { d = JSON.parse(payload); } catch { continue; }
        const stage = d.stage as string | undefined;
        const status = d.status as string | undefined;
        // Auto-reframe is best-effort — if it fails, note it and keep going
        // (the cut still builds from the original clips). Only genuinely fatal
        // errors (probe/transcript, or a top-level error) abort the first pass.
        if (stage === "reframe" && status === "error") { onStage("Auto-reframe unavailable — using original clips"); continue; }
        if (d.error) throw new Error(String(d.error));
        if (stage === "probe") onStage("Reading the video…");
        else if (stage === "scenes") onStage(status === "progress" ? `Finding scene cuts… ${Math.round(Number(d.progress || 0) * 100)}%` : "Finding scene cuts…");
        else if (stage === "transcript") onStage("Transcribing…");
        else if (stage === "reframe") onStage("Auto-reframing to the timeline aspect…");
      }
    }
  }

  // Smart-trim first pass: transcribe-driven silence/filler cut on the primary clip.
  async function buildSmartTrim(files: { path: string }[]) {
    const primary = files[0];
    const tRes = await fetch(`/api/transcribe/${projectId}?mediaFile=${encodeURIComponent(primary.path)}`).then((r) => r.json());
    const transcript = tRes.transcript;
    if (!transcript) throw new Error("No transcript available to trim");
    // Prefer the auto-reframed clip if one exists (same timeline as the source).
    const st = await fetch(`/api/media/${projectId}/analyze?mediaFile=${encodeURIComponent(primary.path)}`).then((r) => r.json());
    const srcName = st.reframed || primary.path;
    const mediaSrc = `/api/media/${projectId}/${srcName}`;
    const cp = await fetch(`/api/cut-plan/${projectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, generate: { mediaSrc, fps: extractedFps } }),
    }).then((r) => r.json());
    if (!cp.ok || !cp.code) throw new Error(cp.error || "Cut plan failed");
    commitComposition(cp.code);
  }

  async function runFirstPass(mode: "smarttrim" | "compose") {
    // Editorial notes can live in the notes box (notionContent) or the prompt box
    // (initialPrompt). The generate route falls back across both; here we just
    // detect whether ANY were attached, to drive the visible signal + prompt.
    const initP = project?.initialPrompt?.trim();
    const hasNotes = !!project?.notionContent?.trim() || !!(initP && initP !== "Edit uploaded footage");
    try {
      const list = await fetch(`/api/media/${projectId}/list`).then((r) => r.json());
      const files: { name: string; path: string; type: string }[] = (list.files ?? []).filter(
        (f: { type: string }) => f.type === "video" || f.type === "audio"
      );
      if (files.length === 0) {
        setFirstPass({ mode, status: "error", fileCount: 0, fileIndex: 0, fileName: "", stageLabel: "", notesAttached: hasNotes, error: "No footage found to analyze. Add media, then re-run from Tools → Analyze." });
        return;
      }
      setFirstPass({ mode, status: "analyzing", fileCount: files.length, fileIndex: 1, fileName: files[0].name, stageLabel: "Starting…", notesAttached: hasNotes });

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setFirstPass((s) => (s ? { ...s, fileIndex: i + 1, fileName: f.name, stageLabel: "Analyzing…" } : s));
        await analyzeOne(f.path, (label) => setFirstPass((s) => (s ? { ...s, stageLabel: label } : s)));
      }

      setFirstPass((s) => (s ? { ...s, status: "building", stageLabel: mode === "smarttrim" ? "Cutting silences + fillers…" : "Writing the first cut…" } : s));
      if (mode === "smarttrim") {
        await buildSmartTrim(files);
        setFirstPass(null);
      } else {
        setFirstPass(null); // hand off to the AI chat's own generating UI
        const prompt = hasNotes
          ? "Build a first cut from my editorial notes: keep the highlighted passages, follow the inline comments, and structure it into topic segments. Ground every cut in the transcript timestamps and scene cuts. If an auto-reframed version of a clip is available, use it."
          : "Build a strong first cut from the transcript and scene cuts: pick the most compelling, self-contained moments and assemble them cleanly. (No editorial notes were attached — use your judgment.) If an auto-reframed version of a clip is available, use it.";
        chatRef.current?.runWithPrompt(prompt);
      }
    } catch (err) {
      setFirstPass((s) => ({ mode, status: "error", fileCount: s?.fileCount ?? 0, fileIndex: s?.fileIndex ?? 0, fileName: s?.fileName ?? "", stageLabel: "", error: err instanceof Error ? err.message : "First pass failed" }));
    }
  }

  // Close the Tools dropdown on an outside click.
  useEffect(() => {
    if (!toolsOpen) return;
    function onClick(e: MouseEvent) {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [toolsOpen]);

  // Auto-save with 2s debounce
  useEffect(() => {
    if (!project) return;
    const annotationsKey = JSON.stringify(terminalAnnotations ?? null);
    const hasCodeChanged = code !== lastSavedRef.current.code;
    const hasChatChanged = chatHistory.length !== lastSavedRef.current.chatLength;
    const hasAnnotationsChanged = annotationsKey !== lastSavedRef.current.annotations;
    const hasStyleChanged = styleMode !== lastSavedRef.current.styleMode;
    const docKey = doc ? JSON.stringify(doc) : "";
    const hasDocChanged = docKey !== lastSavedDocRef.current;
    if (!hasCodeChanged && !hasChatChanged && !hasAnnotationsChanged && !hasStyleChanged && !hasDocChanged) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, chatHistory, styleMode, ...(terminalAnnotations !== undefined ? { terminalAnnotations } : {}), ...(doc ? { doc } : {}) }),
        });
        lastSavedRef.current = { code, chatLength: chatHistory.length, annotations: annotationsKey, styleMode };
        lastSavedDocRef.current = docKey;
      } catch {
        // silent fail
      }
    }, 2000);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [code, chatHistory, terminalAnnotations, styleMode, doc, project, projectId]);

  // Toggle customTheme with an immediate PATCH so the next AI request reads
  // the new value (the debounced save would race against fast chat sends).
  const handleCustomThemeChange = useCallback(async (next: boolean) => {
    setCustomTheme(next);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customTheme: next }),
      });
    } catch {
      // silent — local state is already updated; user can retry
    }
  }, [projectId]);

  // Immediate-PATCH so the next AI request reads the new transition style.
  const handleTransitionStyleChange = useCallback(async (next: TransitionStyle) => {
    setTransitionStyle(next);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transitionStyle: next }),
      });
    } catch {
      // silent — local state is already updated; user can retry
    }
  }, [projectId]);

  // Same immediate-PATCH pattern so the next AI request reads the new value.
  const handleUseSfxChange = useCallback(async (next: boolean) => {
    setUseSfx(next);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useSfx: next }),
      });
    } catch {
      // silent — local state is already updated; user can retry
    }
  }, [projectId]);

  // Force save (Cmd+S)
  const forceSave = useCallback(async () => {
    if (!project) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, chatHistory, styleMode, ...(terminalAnnotations !== undefined ? { terminalAnnotations } : {}) }),
      });
      lastSavedRef.current = {
        code,
        chatLength: chatHistory.length,
        annotations: JSON.stringify(terminalAnnotations ?? null),
        styleMode,
      };
    } catch {
      // silent
    }
  }, [project, projectId, code, chatHistory, terminalAnnotations, styleMode]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        forceSave();
      } else if (mod && e.key === "e") {
        e.preventDefault();
        if (code.trim()) setExportOpen(true);
      } else if (mod && e.key === "z" && !e.shiftKey) {
        // Only handle composition-level undo when focus is NOT inside Monaco
        const active = document.activeElement;
        const inMonaco = active?.closest(".monaco-editor");
        if (!inMonaco) {
          e.preventDefault();
          if (doc) {
            const prevDoc = docHistory.undo();
            if (prevDoc !== null) setDoc(prevDoc);
          } else {
            const prev = codeHistory.undo();
            if (prev !== null) { setCode(prev.code); setChatHistory(prev.chat); }
          }
        }
      } else if (mod && e.key === "z" && e.shiftKey) {
        const active = document.activeElement;
        const inMonaco = active?.closest(".monaco-editor");
        if (!inMonaco) {
          e.preventDefault();
          if (doc) {
            const nextDoc = docHistory.redo();
            if (nextDoc !== null) setDoc(nextDoc);
          } else {
            const next = codeHistory.redo();
            if (next !== null) { setCode(next.code); setChatHistory(next.chat); }
          }
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [forceSave, code, codeHistory, doc, docHistory]);

  const docView = doc && !showCodeEditor ? doc : undefined;

  const { durationInFrames, fps: extractedFps, sceneError } = useMemo(() => {
    if (!code || !code.trim()) return { durationInFrames: 250, fps: project?.settings.fps ?? 25, sceneError: undefined };
    // HyperFrames scenes are plain JS (not Remotion) — read duration/fps from
    // the declared consts instead of evaluating the code as a Remotion scene.
    if (project?.engine === "hyperframes") {
      const m = parseSceneMeta(code);
      return { durationInFrames: m.durationInFrames, fps: m.fps, sceneError: undefined };
    }
    if (docView) {
      return { durationInFrames: docDuration(docView), fps: docView.size.fps, sceneError: undefined };
    }
    const result = evalSceneCode(code);
    return {
      durationInFrames: result?.durationInFrames ?? 250,
      fps: result?.fps ?? project?.settings.fps ?? 25,
      sceneError: result?.error,
    };
  }, [code, docView, project?.settings.fps, project?.engine]);

  // Poll the preview Player for the current frame so the timeline playhead
  // tracks playback. No-ops when the Player isn't mounted (Terminal / HyperFrames
  // / first-pass), so those paths are untouched.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = playerRef.current;
      if (p) {
        const f = p.getCurrentFrame();
        if (typeof f === "number") setCurrentFrame(f);
        setIsPlaying(p.isPlaying());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekTo = useCallback((frame: number) => {
    const p = playerRef.current;
    if (!p) return;
    const max = Math.max(0, durationInFrames - 1);
    p.seekTo(Math.min(max, Math.max(0, Math.round(frame))));
  }, [durationInFrames]);

  const handleScrubStart = useCallback(() => {
    playerRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
  }, []);

  // The editor's insert picker needs to know what media the project holds and
  // how long each file is, so a dropped clip lands at its true length.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    Promise.all([
      fetch(`/api/media/${projectId}/list`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/media/${projectId}/probe-map`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([list, probe]) => {
      if (cancelled) return;
      const files = (list?.files ?? list ?? []) as { name: string; path: string; type: string }[];
      if (Array.isArray(files)) setDocMedia(files);
      if (probe?.fps && probe?.nbFrames) {
        const durations: Record<string, number> = {};
        for (const [rel, frames] of Object.entries(probe.nbFrames as Record<string, number>)) {
          const f = (probe.fps as Record<string, number>)[rel];
          if (f) durations[rel] = frames / f;
        }
        setDocMediaDurations(durations);
      }
    });
    return () => { cancelled = true; };
  }, [doc, projectId]);

  // Fetch native fps per media file (cache-only) for correct trim math on video projects.
  useEffect(() => {
    if (project?.animationType !== "video") return;
    let cancelled = false;
    fetch(`/api/media/${projectId}/probe-map`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.fps) return;
        const fpsMap: Record<string, number> = {};
        for (const [rel, f] of Object.entries(data.fps as Record<string, number>)) {
          fpsMap[`/api/media/${projectId}/${rel}`] = f;
        }
        setNativeFpsBySrc(fpsMap);
        const nbMap: Record<string, number> = {};
        for (const [rel, n] of Object.entries((data.nbFrames ?? {}) as Record<string, number>)) {
          nbMap[`/api/media/${projectId}/${rel}`] = n;
        }
        setMaxSrcFrameBySrc(nbMap);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, project?.animationType]);

  const handleCodeChange = useCallback((newCode: string) => {
    setCode(newCode);
  }, []);

  // Apply a composition change AND record it for undo. The history model keeps the
  // CURRENT code at the top of the stack, so we snapshot the pre-edit state (a
  // no-op if it's already the top) AND the new state — that way one Cmd+Z steps
  // back exactly one edit. (Previously callers pushed only the OLD code and never
  // the new one, so the first edit had nothing to undo to and later undos jumped
  // a step too far.)
  const commitComposition = useCallback((next: string) => {
    if (next === code) return;
    codeHistory.pushSnapshot(code, chatHistory);
    codeHistory.pushSnapshot(next, chatHistory);
    setCode(next);
  }, [code, chatHistory, codeHistory]);

  /** Apply a document change AND record it for undo. Mirrors commitComposition. */
  const commitDoc = useCallback((next: EditorDoc) => {
    setDoc((prev) => {
      if (prev) docHistory.pushSnapshot(prev);
      docHistory.pushSnapshot(next);
      return next;
    });
  }, [docHistory]);

  const handleChatUpdate = useCallback((messages: ChatMessage[]) => {
    setChatHistory(messages);
  }, []);

  // Immediate save when generation completes (no debounce), then generate thumbnail
  const handleGenerationComplete = useCallback(async (finalCode: string, finalChat: ChatMessage[]) => {
    codeHistory.pushSnapshot(finalCode, finalChat);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: finalCode, chatHistory: finalChat }),
      });
      lastSavedRef.current = {
        code: finalCode,
        chatLength: finalChat.length,
        annotations: JSON.stringify(terminalAnnotations ?? null),
        styleMode,
      };
    } catch {
      // silent fail
    }
    fetch(`/api/projects/${projectId}/thumbnail`, { method: "POST" }).catch(() => {});

    // Auto-fix on error: if the freshly generated Remotion scene doesn't compile,
    // relaunch the model to repair it — no manual resend needed. The [SCENE ERROR]
    // is injected into the AI message by ChatPanel's sceneError prop (which keeps
    // the visible chat message clean); we defer to setTimeout(0) so that prop has
    // settled after the setCode → sceneError re-render. Bounded by autoRetryRef.
    if (project?.engine !== "hyperframes" && project?.animationType !== "terminal") {
      const err = evalSceneCode(finalCode)?.error;
      if (err) {
        if (autoRetryRef.current < 2) {
          autoRetryRef.current += 1;
          setTimeout(() => {
            chatRef.current?.runWithPrompt(
              "The preview is showing an error — fix the scene and return the complete corrected file."
            );
          }, 0);
        }
      } else {
        autoRetryRef.current = 0;
      }
    }
  }, [projectId, codeHistory, terminalAnnotations, styleMode, project?.engine, project?.animationType]);

  const isTerminalProject = project?.animationType === "terminal";
  const isHyperframes = project?.engine === "hyperframes";
  const layoutKind = project?.animationType === "video" ? "video" : project?.animationType === "terminal" ? "terminal" : "still";
  const storage =
    typeof window !== "undefined"
      ? window.localStorage
      : ({
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
          clear: () => {},
          key: () => null,
          length: 0,
        } as Storage);
  const horizontalLayout = useDefaultLayout({
    id: `studio-h-${layoutKind}`,
    panelIds: ["main", "chat"],
    storage,
  });
  const verticalLayout = useDefaultLayout({
    // v2: taller editable timeline — bumping the id resets saved layouts once so
    // the new default heights apply.
    id: `studio-v2-${layoutKind}`,
    panelIds: layoutKind === "video" ? ["preview", "timeline", "code"] : ["preview", "code"],
    storage,
  });

  if (loading) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-2)", fontSize: 13 }}>
        Loading project...
      </div>
    );
  }

  if (!project) return null;

  const { width, height } = getResolution(project.settings.orientation, project.settings.resolution);
  const resLabel = `${width}\u00d7${height}`;
  const isVideoProject = project.animationType === "video";
  // The timeline panel mounts for every Remotion-scene project type too —
  // animation / broll / svg compositions are made of <Sequence> blocks and
  // can be reordered, trimmed, and split via the editable timeline.
  // The editable timeline parses Remotion <Sequence> blocks — it doesn't apply
  // to HyperFrames scenes (plain HTML/GSAP, no Sequence model).
  // The visual editor always has a timeline; otherwise it depends on the type.
  const hasTimeline =
    Boolean(docView) ||
    (!isHyperframes &&
    (project.animationType === "video" ||
      project.animationType === "animation" ||
      project.animationType === "broll" ||
      project.animationType === "svg"));
  // Only run the (browser-side) runtime extractor when the static parsers likely
  // can't see the clips: runtime-computed layouts (TransitionSeries, .map, Series).
  //
  // AND only while the timeline actually has nothing else to draw. The extractor
  // is a second hidden <Player> rendering the whole composition, so on a long
  // 4K interview edit it decodes the same footage twice over. Its output feeds
  // the display-only lane and nothing else — doc, data and segment modes all
  // position clips statically — so for those it is pure cost.
  const mayNeedExtraction =
    hasTimeline && /(<TransitionSeries\b|\.map\s*\(|<Series\.Sequence\b)/.test(code);
  const needsExtraction = mayNeedExtraction && timelineMode === "none";

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          height: 48,
          background: "var(--bg-2)",
          borderBottom: "0.5px solid var(--line-1)",
          position: "relative",
          zIndex: 5,
          flexShrink: 0,
        }}
      >
        <IconButton icon="arrowLeft" onClick={() => router.push("/")} title="Back to projects" />
        <Logo size={20} onClick={() => router.push("/")} />
        <div style={{ width: 1, height: 20, background: "var(--line-2)", marginLeft: 4 }} />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{project.name}</div>
          <div className="mono nums" style={{ fontSize: 10, color: "var(--text-2)" }}>
            {resLabel} &middot; {project.settings.fps}fps &middot;{" "}
            {project.settings.orientation === "horizontal" ? "16:9" : project.settings.orientation === "vertical" ? "9:16" : "1:1"}
          </div>
        </div>
        <TypeBadge type={project.animationType} />
        <div style={{ flex: 1 }} />
        {/* Undo / Redo */}
        <div style={{ display: "flex", gap: 1 }}>
          <IconButton
            icon="arrowLeft"
            size={26}
            title="Undo (Cmd+Z)"
            onClick={() => { const prev = codeHistory.undo(); if (prev !== null) { setCode(prev.code); setChatHistory(prev.chat); } }}
            style={{ opacity: codeHistory.canUndo ? 1 : 0.3 }}
          />
          <IconButton
            icon="arrowRight"
            size={26}
            title="Redo (Cmd+Shift+Z)"
            onClick={() => { const next = codeHistory.redo(); if (next !== null) { setCode(next.code); setChatHistory(next.chat); } }}
            style={{ opacity: codeHistory.canRedo ? 1 : 0.3 }}
          />
        </div>
        <div style={{ width: 1, height: 20, background: "var(--line-2)" }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: 3,
            background: "var(--bg-inset)",
            border: "0.5px solid var(--line-2)",
            borderRadius: "var(--r-sm)",
          }}
        >
          <span className="mono" style={{ fontSize: 10, color: "var(--text-2)", padding: "0 6px" }}>
            SAVED
          </span>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--accent)",
              marginRight: 6,
            }}
          />
        </div>
        {/* Convert ratio / Remove background are meaningful for animation scenes,
            but footguns for uploaded footage — hidden for video (reframe handles
            aspect; Remove background does nothing to a video). */}
        {!isTerminalProject && !isVideoProject && (
          <ConvertAspectRatioButton
            projectId={projectId}
            currentOrientation={project.settings.orientation}
            disabled={!code.trim() || isGenerating}
          />
        )}
        {!isTerminalProject && !isVideoProject && (
          <Button variant="outline" size="sm" icon="layers" onClick={() => setSnippetsOpen(true)}>
            Snippets
          </Button>
        )}
        {hasTimeline && !isVideoProject && (
          <Button
            variant="outline"
            size="sm"
            icon="checkerboard"
            title="Remove background (Cmd+Z to undo)"
            disabled={!code.trim() || bgRemovedFlash}
            onClick={() => {
              const next = stripBackgroundsForTransparency(code);
              if (next === code) return;
              commitComposition(next);
              setBgRemovedFlash(true);
              setTimeout(() => setBgRemovedFlash(false), 1500);
            }}
          >
            {bgRemovedFlash ? "Removed" : "Remove background"}
          </Button>
        )}
        {/* Video: fewer top buttons — analyze / smart trim / snippets / assets
            live under one Tools menu; the chat is the main editing surface. */}
        {isVideoProject ? (
          <div style={{ position: "relative" }} ref={toolsRef}>
            <Button variant="outline" size="sm" icon="settings" onClick={() => setToolsOpen((v) => !v)}>
              Tools <Icon name="chevronDown" size={12} />
            </Button>
            {toolsOpen && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "100%",
                  marginTop: 6,
                  minWidth: 200,
                  padding: 5,
                  background: "var(--bg-3)",
                  border: "0.5px solid var(--line-2)",
                  borderRadius: "var(--r-sm)",
                  boxShadow: "var(--sh-float)",
                  zIndex: 20,
                }}
              >
                {[
                  { icon: "search", label: "Analyze footage", onClick: () => setAnalyzeOpen(true) },
                  { icon: "sparkle", label: "Smart trim (re-run)", onClick: () => setSmartTrimOpen(true) },
                  { icon: "layers", label: "Snippets", onClick: () => setSnippetsOpen(true) },
                  { icon: "folder", label: "Assets", onClick: () => setAssetsOpen(true) },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => { setToolsOpen(false); item.onClick(); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "8px 8px", fontSize: 12, background: "transparent", border: "none",
                      color: "var(--text-0)", borderRadius: 4, cursor: "pointer", textAlign: "left",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-4)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Icon name={item.icon} size={13} style={{ color: "var(--text-2)" }} />
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Button variant="outline" size="sm" icon="folder" onClick={() => setAssetsOpen(true)}>
            Assets
          </Button>
        )}
        {doc && (
          <Button
            variant="outline"
            size="sm"
            icon={showCodeEditor ? "layers" : "code"}
            title={showCodeEditor
              ? "Switch back to the visual editor"
              : "Show the original code view. Your editor arrangement is kept — this only changes which editor is on screen."}
            onClick={() => setShowCodeEditor((v) => !v)}
          >
            {showCodeEditor ? "Editor" : "Code view"}
          </Button>
        )}
        {!doc && !isTerminalProject && !isHyperframes && (
          <Button
            variant="outline"
            size="sm"
            icon="layers"
            title="Open this project in the visual editor. The existing composition becomes one block on a track — nothing is parsed or rewritten, and the code stays exactly as it is."
            onClick={() => {
              const evaluated = evalSceneCode(code);
              commitDoc(
                docFromScene(
                  { width, height, fps: evaluated?.fps ?? project.settings.fps },
                  code,
                  evaluated?.durationInFrames ?? 250,
                  project.name,
                ),
              );
            }}
          >
            Open in editor
          </Button>
        )}
        {isTerminalProject ? (
          <Button
            variant="primary"
            size="sm"
            icon="download"
            onClick={() => {
              const a = document.createElement("a");
              a.href = `/api/vhs/${projectId}/output`;
              a.download = `${project.name}.mp4`;
              a.click();
            }}
            disabled={!code.trim()}
          >
            Download
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon="download"
            onClick={() => setExportOpen(true)}
            disabled={!code.trim()}
          >
            Export
          </Button>
        )}
      </div>

      {/* Studio layout: resizable panels */}
      <div style={{ flex: 1, minHeight: 0, background: "var(--line-1)" }}>
        <Group
          orientation="horizontal"
          defaultLayout={horizontalLayout.defaultLayout}
          onLayoutChanged={horizontalLayout.onLayoutChanged}
          style={{ height: "100%" }}
        >
          <Panel id="main" defaultSize="72%" minSize="30%">
            <Group
              orientation="vertical"
              defaultLayout={verticalLayout.defaultLayout}
              onLayoutChanged={verticalLayout.onLayoutChanged}
              style={{ height: "100%" }}
            >
              <Panel id="preview" defaultSize={hasTimeline ? "50%" : "65%"} minSize="15%">
                <div style={{ background: "#000", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
                  {docView ? (
                    <EditorPreview doc={docView} playerRef={playerRef} />
                  ) : isTerminalProject ? (
                    <TerminalPreview
                      projectId={projectId}
                      code={code}
                      onReplaceCode={commitComposition}
                      annotations={terminalAnnotations}
                      onAnnotationsChange={setTerminalAnnotations}
                      customTheme={customTheme}
                      onCustomThemeChange={handleCustomThemeChange}
                    />
                  ) : isHyperframes ? (
                    <HyperframesPreview code={code} width={width} height={height} />
                  ) : firstPass ? (
                    <FirstPassProgress state={firstPass} onDismiss={() => setFirstPass(null)} />
                  ) : (
                    <PreviewPanel code={code} width={width} height={height} svgContents={project.svgContents} playerRef={playerRef} />
                  )}
                </div>
              </Panel>
              {hasTimeline && (
                <>
                  <Separator className="resize-handle resize-handle-horizontal" />
                  <Panel id="timeline" defaultSize="30%" minSize="12%">
                    <div style={{ background: "var(--bg-2)", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                      {docView ? (
                      <DocTimeline
                        doc={docView}
                        onChange={commitDoc}
                        currentFrame={currentFrame}
                        onSeek={seekTo}
                        onScrubStart={handleScrubStart}
                        onTogglePlay={togglePlay}
                        mediaFiles={docMedia}
                        mediaDurations={docMediaDurations}
                        projectId={projectId}
                      />
                      ) : (
                      <Timeline
                        code={code}
                        fps={extractedFps}
                        durationInFrames={durationInFrames}
                        onCodeChange={commitComposition}
                        onEditModeChange={setTimelineMode}
                        nativeFpsBySrc={nativeFpsBySrc}
                        maxSrcFrameBySrc={maxSrcFrameBySrc}
                        resolvedClips={needsExtraction ? resolvedClips : null}
                        extracting={needsExtraction}
                        currentFrame={currentFrame}
                        onSeek={seekTo}
                        onScrubStart={handleScrubStart}
                        onTogglePlay={togglePlay}
                        isPlaying={isPlaying}
                      />
                      )}
                    </div>
                  </Panel>
                </>
              )}
              <Separator className="resize-handle resize-handle-horizontal" />
              <Panel id="code" defaultSize={hasTimeline ? "20%" : "35%"} minSize="10%">
                <div style={{ background: "var(--bg-2)", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <CodeEditor
                    code={code}
                    onChange={handleCodeChange}
                    language={isTerminalProject ? "vhs" : "typescript"}
                    filename={isTerminalProject ? "tape.tape" : isHyperframes ? "scene.js" : "Scene.tsx"}
                  />
                </div>
              </Panel>
            </Group>
          </Panel>
          <Separator className="resize-handle resize-handle-vertical" />
          <Panel id="chat" defaultSize="28%" minSize="18%" maxSize="50%">
            <div style={{ background: "var(--bg-2)", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              <ChatPanel
                ref={chatRef}
                projectId={projectId}
                chatHistory={chatHistory}
                initialPrompt={project.initialPrompt}
                onCodeUpdate={handleCodeChange}
                onChatUpdate={handleChatUpdate}
                isGenerating={isGenerating}
                setIsGenerating={setIsGenerating}
                projectSettings={project.settings}
                animationType={project.animationType}
                engine={project.engine}
                notionContent={project.notionContent}
                scriptWithTimestamps={project.scriptWithTimestamps}
                svgContents={project.svgContents}
                styleMode={styleMode}
                onStyleModeChange={setStyleMode}
                topicCardStyle={topicCardStyle}
                transitionStyle={transitionStyle}
                onTransitionStyleChange={handleTransitionStyleChange}
                useSfx={useSfx}
                onUseSfxChange={handleUseSfxChange}
                currentCode={code}
                autoSend={
                  !project.code &&
                  project.chatHistory.length === 0 &&
                  // For Smart Trim projects the dialog generates the composition,
                  // not the AI chat — captured from the URL once on mount before
                  // the ?action=smartTrim param gets cleaned.
                  initialAutoAction !== "smartTrim" &&
                  // Video projects must be Analyzed first, then edited via chat —
                  // never auto-generate blind on load.
                  !isVideoProject
                }
                onGenerationComplete={handleGenerationComplete}
                sceneError={sceneError}
              />
            </div>
          </Panel>
        </Group>
      </div>

      {needsExtraction && !isTerminalProject && (
        <TimelineExtractor
          code={code}
          width={width}
          height={height}
          fps={extractedFps}
          durationInFrames={durationInFrames}
          onResolved={handleResolved}
        />
      )}

      <AssetBrowser
        open={assetsOpen}
        onClose={() => setAssetsOpen(false)}
        onCopyPath={() => {}}
      />

      <SnippetBrowser
        open={snippetsOpen}
        onClose={() => setSnippetsOpen(false)}
        hasExistingCode={code.trim().length > 0}
        onUseSnippet={commitComposition}
      />

      <SmartTrimDialog
        open={smartTrimOpen}
        onClose={() => setSmartTrimOpen(false)}
        projectId={projectId}
        fps={extractedFps}
        hasMediaFolder={!!project.mediaFolder}
        hasExistingCode={code.trim().length > 0}
        onApply={commitComposition}
      />

      <AnalyzeDialog
        open={analyzeOpen}
        onClose={() => setAnalyzeOpen(false)}
        projectId={projectId}
        hasMediaFolder={!!project.mediaFolder}
      />

      {(() => {
        let exportCode = code;
        let exportDuration = durationInFrames;
        let exportFps = extractedFps;
        let exportWidth = width;
        let exportHeight = height;
        if (isTerminalProject && terminalAnnotations) {
          const origin = typeof window !== "undefined" ? window.location.origin : "";
          const videoUrl = `${origin}/api/vhs/${projectId}/output`;
          const plan = buildTerminalExportPlan(videoUrl, terminalAnnotations);
          exportCode = plan.code;
          exportDuration = plan.durationInFrames;
          exportFps = plan.fps;
          exportWidth = plan.width;
          exportHeight = plan.height;
        }
        return (
          <ExportDialog
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            code={exportCode}
            durationInFrames={exportDuration}
            fps={exportFps}
            width={exportWidth}
            height={exportHeight}
            projectName={project.name}
            projectId={projectId}
            engine={project.engine}
            doc={doc}
          />
        );
      })()}

      <GeneratingOverlay visible={isGenerating} />
    </div>
  );
}
