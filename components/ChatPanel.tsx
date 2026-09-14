"use client";

import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import type { ChatMessage, SvgFile } from "@/lib/types";
import type { EditorDoc } from "@/lib/editor-doc";
import Icon from "@/components/ui/Icon";
import Button from "@/components/ui/Button";
import IconButton from "@/components/ui/IconButton";
import { normalizeTapeQuotes } from "@/lib/tape-parser";

function extractCodeFromResponse(text: string, animationType?: string): string {
  // Accept tsx/js/html fences — older responses used a variety of them.
  const fenceMatch = text.match(/```(?:tsx|typescript|jsx|js|javascript|html|tape|vhs)?\s*\n([\s\S]*?)```/);
  let extracted = "";
  if (fenceMatch) {
    extracted = fenceMatch[1].trim();
  } else {
    const openFence = text.match(/```(?:tsx|typescript|jsx|js|javascript|html|tape|vhs)?\s*\n([\s\S]*)/);
    if (openFence) {
      extracted = openFence[1].trim();
    } else if (animationType === "terminal" && text.trim().length > 0) {
      // No code fence. For terminal projects, the AI is instructed to emit only
      // the .tape content, so an unfenced response is the script itself.
      extracted = text.trim();
    }
    // For non-terminal types with no fence, the model usually returns
    // prose-only; returning that would clobber Scene.tsx with markdown, so we
    // signal "no code" and preserve the existing file.
  }
  if (!extracted) return "";
  // VHS doesn't support backslash-escaped quotes; the AI occasionally emits
  // them anyway. Rewrite Type lines to use a quote style that actually parses.
  if (animationType === "terminal") extracted = normalizeTapeQuotes(extracted);
  return extracted;
}

interface SvgAttachment {
  path: string;
  content: string;
  filename: string;
}

interface SvgAssetOption {
  name: string;
  path: string;
}

export interface ChatPanelHandle {
  /** Programmatically send a prompt as if the user had typed it.
   *  Pass `overrideCode` when the caller has just mutated the editor code
   *  and React hasn't yet propagated the new value into our props. */
  runWithPrompt(prompt: string, opts?: { overrideCode?: string }): void;
}

interface ChatPanelProps {
  projectId: string;
  chatHistory: ChatMessage[];
  initialPrompt: string;
  onCodeUpdate: (code: string) => void;
  onChatUpdate: (messages: ChatMessage[]) => void;
  isGenerating: boolean;
  setIsGenerating: (v: boolean) => void;
  projectSettings: {
    resolution: string;
    orientation: string;
    fps: number;
  };
  animationType: string;
  notionContent?: string;
  scriptWithTimestamps?: string;
  svgContents?: SvgFile[];
  currentCode: string;
  autoSend?: boolean;
  onGenerationComplete?: (code: string, chatHistory: ChatMessage[]) => void;
  sceneError?: string;
  styleMode?: import("@/lib/types").StyleMode;
  onStyleModeChange?: (mode: import("@/lib/types").StyleMode) => void;
  topicCardStyle?: import("@/lib/types").TopicCardStyle;
  transitionStyle?: import("@/lib/types").TransitionStyle;
  onTransitionStyleChange?: (mode: import("@/lib/types").TransitionStyle) => void;
  useSfx?: boolean;
  onUseSfxChange?: (v: boolean) => void;
  /**
   * With a document open the chat edits the TIMELINE instead of the code file:
   * the same box, pointed at /api/edit-doc, where the model drives real editing
   * tools rather than writing TSX. Without one, nothing below changes.
   */
  doc?: EditorDoc;
  selectedIds?: string[];
  playheadFrame?: number;
  onDocChanged?: (doc: EditorDoc, opts?: { transient?: boolean }) => void;
}

const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  {
    projectId,
    chatHistory,
    initialPrompt,
    onCodeUpdate,
    onChatUpdate,
    isGenerating,
    setIsGenerating,
    projectSettings,
    animationType,
    notionContent,
    scriptWithTimestamps,
    svgContents,
    currentCode,
    autoSend,
    onGenerationComplete,
    sceneError,
    styleMode,
    onStyleModeChange,
    topicCardStyle,
    transitionStyle,
    onTransitionStyleChange,
    useSfx,
    onUseSfxChange,
    doc,
    selectedIds,
    playheadFrame,
    onDocChanged,
  },
  ref,
) {
  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [attachedSvgs, setAttachedSvgs] = useState<SvgAttachment[]>([]);
  const [svgPickerOpen, setSvgPickerOpen] = useState(false);
  const [svgOptions, setSvgOptions] = useState<SvgAssetOption[]>([]);
  const [svgLoading, setSvgLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoSentRef = useRef(false);
  const svgPickerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous mirror of isGenerating — the prop's setter is async, so we
  // can't rely on the React state to gate re-entry inside sendMessage when
  // runWithPrompt fires while a stream is already in flight.
  const generatingRef = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    // streamingContent too, or the view stops following once the prose starts.
  }, [chatHistory, isGenerating, streamingContent]);

  useEffect(() => {
    if (!svgPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (svgPickerRef.current && !svgPickerRef.current.contains(e.target as Node)) {
        setSvgPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [svgPickerOpen]);

  useEffect(() => {
    if (autoSend && !autoSentRef.current && !isGenerating && chatHistory.length === 0) {
      autoSentRef.current = true;
      sendMessage(initialPrompt);
    }
  }, [autoSend]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openSvgPicker() {
    setSvgPickerOpen(true);
    setSvgLoading(true);
    try {
      const res = await fetch("/api/assets");
      if (!res.ok) return;
      const groups: { folder: string; items: { name: string; path: string; type: string }[] }[] = await res.json();
      const svgs: SvgAssetOption[] = [];
      for (const group of groups) {
        for (const item of group.items) {
          if (item.type === "svg") {
            svgs.push({ name: item.name, path: item.path });
          }
        }
      }
      setSvgOptions(svgs);
    } catch {
      // ignore
    } finally {
      setSvgLoading(false);
    }
  }

  async function selectSvg(option: SvgAssetOption) {
    setSvgPickerOpen(false);
    try {
      const res = await fetch(`/api/assets/content?path=${encodeURIComponent(option.path)}`);
      if (!res.ok) return;
      const data: { content: string; filename: string } = await res.json();
      setAttachedSvgs((prev) => [...prev, { path: option.path, content: data.content, filename: data.filename }]);
    } catch {
      // ignore
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      runWithPrompt(prompt, opts) {
        // Force preemption: if an autoSend / earlier prompt is mid-stream,
        // abort it and start the new one immediately. Without this the snippet
        // customize silently bails when autoSend is racing with the click.
        sendMessage(prompt, opts?.overrideCode, { force: true });
      },
    }),
    // sendMessage is stable for the lifetime of the component (defined inline),
    // but its closure captures props — re-bind the handle whenever any prop
    // sendMessage reads changes, otherwise runWithPrompt would use stale state.
    //
    // `doc` MUST be in here. sendMessage branches on it to choose /api/edit-doc
    // over /api/generate, and a timeline created AFTER mount (the "Start a
    // timeline" button) would otherwise leave runWithPrompt closed over
    // doc === undefined — so a first pass would write a TSX file and silently
    // ignore the timeline it was supposed to fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatHistory, currentCode, isGenerating, projectSettings, animationType, notionContent, scriptWithTimestamps, svgContents, projectId, styleMode, topicCardStyle, transitionStyle, useSfx, attachedSvgs, sceneError, doc, selectedIds, playheadFrame, onDocChanged],
  );

  async function sendMessage(text: string, overrideCode?: string, opts: { force?: boolean } = {}) {
    if (!text.trim()) return;
    if (generatingRef.current) {
      if (opts.force && abortRef.current) {
        // Cancel the in-flight stream. Its catch branch handles AbortError
        // silently and won't append a stale assistant message.
        abortRef.current.abort();
      } else {
        return;
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    generatingRef.current = true;
    setIsGenerating(true);
    setStreamingContent("");

    let messageForAI = text.trim();
    if (sceneError) {
      messageForAI = `[SCENE ERROR: ${sceneError}]\n\n${messageForAI}`;
    }
    if (attachedSvgs.length > 0) {
      const svgBlock = attachedSvgs
        .map((svg, i) => `[SVG ${i + 1}: ${svg.filename}]\nPath: ${svg.path}\n${svg.content}\n[END SVG ${i + 1}]`)
        .join("\n\n");
      messageForAI = `${svgBlock}\n\n${messageForAI}`;
    }

    const displayText = attachedSvgs.length > 0
      ? `${text.trim()}\n\nAttached SVGs: ${attachedSvgs.map((s) => s.filename).join(", ")}`
      : text.trim();

    const userMessage: ChatMessage = { role: "user", content: displayText };
    const messagesForAI: ChatMessage[] = [...chatHistory, { role: "user", content: messageForAI }];
    const updatedHistory = [...chatHistory, userMessage];
    onChatUpdate(updatedHistory);

    setAttachedSvgs([]);

    let fullResponse = "";

    try {
      // The timeline is open: edit the document, not the code file.
      if (doc && onDocChanged) {
        await editDocument(messagesForAI, updatedHistory, controller);
        return;
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          messages: messagesForAI,
          projectSettings,
          animationType,
          notionContent,
          scriptWithTimestamps,
          svgContents,
          currentCode: overrideCode ?? currentCode,
          projectId,
          styleMode,
          topicCardStyle,
          transitionStyle,
          useSfx,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.text) {
                fullResponse += parsed.text;
                const extracted = extractCodeFromResponse(fullResponse, animationType);
                if (extracted && extracted.length > 50) {
                  onCodeUpdate(extracted);
                }
              }
            } catch {
              // incomplete JSON chunk
            }
          }
        }
      }

      const finalCode = extractCodeFromResponse(fullResponse, animationType);
      if (finalCode && finalCode.length > 50) {
        onCodeUpdate(finalCode);
      }

      // For terminal projects, the AI may emit the entire .tape script without
      // any fences (legacy responses) — treat the whole thing as code so it
      // doesn't get duplicated into the chat as prose.
      const hadFence = /```[\s\S]*?```/.test(fullResponse);
      const textOnly =
        animationType === "terminal" && !hadFence && finalCode && finalCode.length > 50
          ? ""
          : fullResponse.replace(/```[\s\S]*?```/g, "").trim();
      let doneNote: string;
      if (!fullResponse.trim()) {
        doneNote =
          "⚠️ The model returned an empty response. This sometimes happens with long prompts or model timeouts — try sending the message again.";
      } else if (finalCode && finalCode.length > 50) {
        doneNote = textOnly
          ? `${textOnly}\n\nAnimation generated — preview is live.`
          : "Animation generated — preview is live.";
      } else {
        doneNote = textOnly
          ? textOnly
          : "⚠️ The model responded but didn't produce a code block. Try rephrasing the request.";
      }
      const assistantMessage: ChatMessage = { role: "assistant", content: doneNote };
      const finalHistory = [...updatedHistory, assistantMessage];
      onChatUpdate(finalHistory);

      if (onGenerationComplete && finalCode && finalCode.length > 50) {
        onGenerationComplete(finalCode, finalHistory);
      }
    } catch (err) {
      // Preempted by a later runWithPrompt — drop the partial state silently.
      // The new sendMessage call has already taken over generatingRef / abortRef
      // and will emit its own chat updates.
      if ((err as { name?: string } | null)?.name === "AbortError") {
        return;
      }
      const msg = err instanceof Error ? err.message : "Unknown error";
      const errorMessage: ChatMessage = { role: "assistant", content: `Error: ${msg}` };
      onChatUpdate([...updatedHistory, errorMessage]);
    } finally {
      // Only clear the global flags if this invocation still owns them — a
      // preempting call will have swapped abortRef.current to its own controller.
      if (abortRef.current === controller) {
        abortRef.current = null;
        generatingRef.current = false;
        setIsGenerating(false);
        setStreamingContent("");
      }
    }
  }

  /**
   * Ask the AI to edit the open timeline.
   *
   * The server owns the document while the turn runs and streams it back, so a
   * turn that fails part-way can never leave a half-applied edit here. Documents
   * arriving mid-turn are applied but NOT recorded (`transient`), and the last
   * one commits — that is what makes a ten-tool-call edit a single Cmd+Z, using
   * the same mechanism a mouse drag already uses.
   */
  async function editDocument(
    messagesForAI: ChatMessage[],
    updatedHistory: ChatMessage[],
    controller: AbortController,
  ) {
    let fullResponse = "";
    let latestDoc: EditorDoc | null = null;
    let edited = false;

    const res = await fetch("/api/edit-doc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        messages: messagesForAI,
        doc,
        projectId,
        selectedIds: selectedIds ?? [],
        playheadFrame: playheadFrame ?? 0,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    // SSE events can be split across chunks — buffer until a full line arrives,
    // or a document (which is large) gets dropped as unparseable JSON.
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        let parsed: { text?: string; doc?: EditorDoc; transient?: boolean; error?: string; edited?: boolean };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.text) {
          fullResponse += parsed.text;
          setStreamingContent(fullResponse);
        }
        if (parsed.doc) {
          latestDoc = parsed.doc;
          onDocChanged?.(parsed.doc, { transient: parsed.transient === true });
        }
        if (parsed.edited) edited = true;
      }
    }

    // Commit whatever the turn ended on, so the whole turn is one undo step even
    // if the stream only ever sent transient updates.
    if (latestDoc) onDocChanged?.(latestDoc);

    const said = fullResponse.replace(/```[\s\S]*?```/g, "").trim();
    const note = said
      ? said
      : edited
        ? "Done — the timeline is updated."
        : "⚠️ The model didn't change anything. Try saying more specifically what to edit.";
    onChatUpdate([...updatedHistory, { role: "assistant", content: note }]);
  }

  function handleSend() {
    if (!input.trim()) return;
    const text = input;
    setInput("");
    sendMessage(text);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderBottom: "0.5px solid var(--line-1)",
        }}
      >
        <Icon name="chat" size={13} style={{ color: "var(--text-2)" }} />
        <span className="mono cap" style={{ color: "var(--text-1)" }}>
          Chat
        </span>
        <div style={{ flex: 1 }} />
        {onStyleModeChange && animationType !== "terminal" && animationType !== "video" && (
          <select
            value={styleMode ?? "default"}
            onChange={(e) => onStyleModeChange(e.target.value as import("@/lib/types").StyleMode)}
            title="Animation style — affects how the AI composes scenes"
            style={{
              fontSize: 10,
              fontFamily: "var(--mono)",
              padding: "3px 6px",
              background: "var(--bg-3)",
              color: "var(--text-1)",
              border: "0.5px solid var(--line-2)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            <option value="default">style: default</option>
            <option value="kinetic">style: kinetic</option>
            <option value="editorial">style: editorial</option>
            <option value="cinematic">style: cinematic</option>
          </select>
        )}
        {onTransitionStyleChange && animationType !== "terminal" && animationType !== "video" && (
          <select
            value={transitionStyle ?? "cut"}
            onChange={(e) => onTransitionStyleChange(e.target.value as import("@/lib/types").TransitionStyle)}
            title="How scenes transition — affects the AI's scene handoffs"
            style={{
              fontSize: 10,
              fontFamily: "var(--mono)",
              padding: "3px 6px",
              background: "var(--bg-3)",
              color: "var(--text-1)",
              border: "0.5px solid var(--line-2)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            <option value="cut">transition: cut</option>
            <option value="blend">transition: blend</option>
            <option value="camera">transition: camera</option>
          </select>
        )}
        {onUseSfxChange && animationType !== "terminal" && (
          <button
            onClick={() => onUseSfxChange(!useSfx)}
            title="Toggle whether the AI may add sound effects"
            className="mono"
            style={{
              fontSize: 10,
              padding: "3px 6px",
              background: useSfx ? "var(--accent-soft)" : "var(--bg-3)",
              color: useSfx ? "var(--accent)" : "var(--text-2)",
              border: `0.5px solid ${useSfx ? "var(--accent-line)" : "var(--line-2)"}`,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            sfx: {useSfx ? "on" : "off"}
          </button>
        )}
        <span className="mono nums" style={{ fontSize: 10, color: "var(--text-3)" }}>
          {chatHistory.length} msgs
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="vt-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14 }}
      >
        {/* Initial prompt */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                background: "var(--accent)",
                color: "var(--accent-ink)",
                display: "grid",
                placeItems: "center",
                fontSize: 9,
                fontWeight: 700,
              }}
            >
              <Icon name="sparkle" size={10} />
            </div>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-1)" }}>System</span>
          </div>
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.55,
              color: "var(--text-0)",
              paddingLeft: 24,
              whiteSpace: "pre-wrap",
            }}
          >
            {initialPrompt}
          </div>
        </div>

        {chatHistory.map((msg, i) => {
          const isUser = msg.role === "user";
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    background: isUser ? "var(--bg-4)" : "var(--accent)",
                    color: isUser ? "var(--text-0)" : "var(--accent-ink)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 9,
                    fontWeight: 700,
                  }}
                >
                  {isUser ? "Y" : <Icon name="sparkle" size={10} />}
                </div>
                <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-1)" }}>
                  {isUser ? "You" : "Studio"}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: "var(--text-0)",
                  paddingLeft: 24,
                  whiteSpace: "pre-wrap",
                }}
              >
                {msg.role === "assistant" ? <MessageContent content={msg.content} /> : msg.content}
              </div>
            </div>
          );
        })}

        {isGenerating && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 4,
              paddingLeft: 24,
              fontSize: 12,
              color: "var(--text-2)",
            }}
          >
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "vt-dot-fade 1.4s ease-in-out infinite",
              }}
            />
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "vt-dot-fade 1.4s ease-in-out .2s infinite",
              }}
            />
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "vt-dot-fade 1.4s ease-in-out .4s infinite",
              }}
            />
            <span style={{ marginLeft: 4 }}>{streamingContent.trim() ? "Working…" : "Thinking…"}</span>
          </div>
        )}

        {/*
          What the AI is saying WHILE it works. It was being accumulated and
          thrown away, so a ninety-second timeline edit showed three dots and
          nothing else — you could not tell whether it had understood you, was
          part-way through, or had wedged.
          Only on the timeline path: the /api/generate stream is mostly a TSX
          file, and streaming a scene file into the chat would be noise.
        */}
        {isGenerating && doc && streamingContent.trim() && (
          <div
            style={{
              marginTop: 6,
              paddingLeft: 24,
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--text-2)",
              whiteSpace: "pre-wrap",
            }}
          >
            {streamingContent.trim()}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: 10, borderTop: "0.5px solid var(--line-1)" }}>
        {/* SVG attachment chips */}
        {attachedSvgs.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {attachedSvgs.map((svg, i) => (
              <div
                key={i}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 6px",
                  fontSize: 10,
                  background: "var(--accent-soft)",
                  border: "0.5px solid var(--accent-line)",
                  borderRadius: 3,
                  color: "var(--accent)",
                }}
              >
                <Icon name="image" size={10} />
                <span className="mono">{svg.filename}</span>
                <button
                  onClick={() => setAttachedSvgs((prev) => prev.filter((_, j) => j !== i))}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent)",
                    cursor: "pointer",
                    padding: 0,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            background: "var(--bg-inset)",
            border: "0.5px solid var(--line-2)",
            borderRadius: "var(--r-sm)",
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask for a change..."
            rows={2}
            disabled={isGenerating}
            className="vt-scroll"
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-0)",
              fontSize: 12.5,
              fontFamily: "inherit",
              resize: "none",
              padding: 0,
              lineHeight: 1.5,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ position: "relative" }} ref={svgPickerRef}>
              <IconButton icon="attach" size={22} title="Attach SVG" onClick={openSvgPicker} disabled={isGenerating} />
              {svgPickerOpen && (
                <div
                  style={{
                    position: "absolute",
                    bottom: "100%",
                    left: 0,
                    marginBottom: 6,
                    width: 240,
                    maxHeight: 200,
                    overflowY: "auto",
                    background: "var(--bg-3)",
                    border: "0.5px solid var(--line-2)",
                    borderRadius: "var(--r-sm)",
                    boxShadow: "var(--sh-float)",
                    zIndex: 50,
                  }}
                >
                  <div
                    style={{
                      padding: "6px 10px",
                      borderBottom: "0.5px solid var(--line-1)",
                      fontSize: 10,
                      color: "var(--text-2)",
                      fontWeight: 500,
                    }}
                  >
                    Select SVG to animate
                  </div>
                  {svgLoading ? (
                    <div style={{ padding: 10, fontSize: 11, color: "var(--text-2)" }}>Loading...</div>
                  ) : svgOptions.length === 0 ? (
                    <div style={{ padding: 10, fontSize: 11, color: "var(--text-2)" }}>No SVG files in assets</div>
                  ) : (
                    <div style={{ padding: 4 }}>
                      {svgOptions.map((opt) => (
                        <button
                          key={opt.path}
                          onClick={() => selectSvg(opt)}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 8px",
                            fontSize: 11,
                            color: "var(--text-0)",
                            background: "transparent",
                            border: "none",
                            borderRadius: 4,
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-4)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <div style={{ fontWeight: 500 }}>{opt.name}</div>
                          <div className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
                            {opt.path}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: "var(--text-3)", marginRight: 4 }}>
              <Kbd>&#9166;</Kbd>
            </span>
            <Button variant="primary" size="sm" onClick={handleSend} disabled={!input.trim() || isGenerating} icon="send">
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatPanel;

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 18,
        padding: "0 5px",
        fontSize: 10,
        color: "var(--text-1)",
        background: "var(--bg-3)",
        border: "0.5px solid var(--line-2)",
        borderRadius: 3,
      }}
    >
      {children}
    </span>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          return (
            <details key={i} style={{ margin: "4px 0" }}>
              <summary style={{ color: "var(--accent)", cursor: "pointer", fontSize: 10 }}>Code block</summary>
              <pre className="mono" style={{ marginTop: 4, fontSize: 10, color: "var(--text-2)", overflowX: "auto" }}>
                {part}
              </pre>
            </details>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
