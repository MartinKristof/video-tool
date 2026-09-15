"use client";

import React, { useState, useEffect, useMemo } from "react";
import Modal from "@/components/ui/Modal";
import Icon from "@/components/ui/Icon";
import { BRAND } from "@/lib/brand";
import { SNIPPET_SCHEMAS } from "@/lib/snippet-schemas";
import { SNIPPET_ICONS } from "@/lib/snippet-icons";
import { renderSnippet } from "@/lib/snippet-template";
import SnippetParamsForm from "@/components/SnippetParamsForm";

interface Snippet {
  id: string;
  name: string;
  subtitle: string;
  code: string;
}

interface SnippetBrowserProps {
  open: boolean;
  onClose: () => void;
  hasExistingCode: boolean;
  /**
   * `provenance` carries the snippet id and the values it was rendered from, so
   * a visual-editor block can reopen this form later. Ignored by the code editor,
   * which only ever replaces the whole project.
   */
  onUseSnippet: (code: string, provenance?: { id: string; values: Record<string, unknown> }) => void;
  /** Render as a panel instead of a modal, for use as a tab. */
  inline?: boolean;
}

// Every preview accent is orange — the brand is orange-only. Icons still vary
// per snippet so the gallery is visually scannable.
const PREVIEW_COLORS: Record<string, string> = {
  IntroCard: BRAND.colors.orange,
  LowerThird: BRAND.colors.orange,
  EndCard: BRAND.colors.orange,
  StatCallout: BRAND.colors.orange,
  QuoteCard: BRAND.colors.orange,
  LogoBumper: BRAND.colors.orange,
  CalloutBanner: BRAND.colors.orange,
  ListReveal: BRAND.colors.orange,
  CodeSnippet: BRAND.colors.orange,
  SymbolBug: BRAND.colors.orange,
  PathReveal: BRAND.colors.orange,
  RisingStarsList: BRAND.colors.orange,
  LogoGridStrip: BRAND.colors.orange,
  FourQuadrant: BRAND.colors.orange,
  BeforeAfter: BRAND.colors.orange,
  EventCard: BRAND.colors.orange,
};

export default function SnippetBrowser({
  open,
  onClose,
  hasExistingCode,
  onUseSnippet,
  inline,
}: SnippetBrowserProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pendingProvenance, setPendingProvenance] = useState<{ id: string; values: Record<string, unknown> } | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // Two-step flow: gallery (selectedId === null) → params form (selectedId set).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // When the user clicks Insert in the form, we stash the rendered code here
  // so the confirm-replace dialog can apply it after the user accepts.
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  useEffect(() => {
    // As a tab there is no `open` to wait for — it is mounted or it isn't.
    if (!open && !inline) return;
    let cancelled = false;
    fetch("/api/snippets")
      .then((r) => r.json())
      .then((data: Snippet[]) => {
        if (!cancelled) setSnippets(data);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, inline]);

  // Reset the two-step flow whenever the modal closes. A tab never closes, so
  // it keeps whatever step it was on. The modal stays mounted to animate out,
  // which rules out resetting through a key.
  useEffect(() => {
    if (!open && !inline) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setSelectedId(null);
      setPendingCode(null);
      setConfirmId(null);
    }
  }, [open, inline]);

  const selectedSnippet = useMemo(
    () => (selectedId ? snippets.find((s) => s.id === selectedId) ?? null : null),
    [selectedId, snippets],
  );
  const selectedSchema = selectedId ? SNIPPET_SCHEMAS[selectedId] : undefined;

  function handleSelect(snippet: Snippet) {
    const schema = SNIPPET_SCHEMAS[snippet.id];
    const hasParams = schema && Object.keys(schema.params).length > 0;
    if (!hasParams) {
      // Zero-param snippet — go straight to insert (with confirm if needed).
      applyCode(snippet.code);
      return;
    }
    setSelectedId(snippet.id);
  }

  function applyCode(code: string, provenance?: { id: string; values: Record<string, unknown> }) {
    if (hasExistingCode) {
      setPendingCode(code);
      setPendingProvenance(provenance);
      setConfirmId("__pending__");
      return;
    }
    onUseSnippet(code, provenance);
    if (inline) setSelectedId(null); else onClose();
  }

  function handleInsert(values: Record<string, unknown>) {
    if (!selectedSnippet || !selectedSchema) return;
    const rendered = renderSnippet(selectedSnippet.code, selectedSchema, values);
    applyCode(rendered, { id: selectedSnippet.id, values });
  }

  function confirmReplace() {
    if (pendingCode) {
      onUseSnippet(pendingCode, pendingProvenance);
    }
    setPendingCode(null);
    setConfirmId(null);
    onClose();
  }

  function cancelReplace() {
    setPendingCode(null);
    setConfirmId(null);
  }

  function copySource(snippet: Snippet) {
    navigator.clipboard.writeText(snippet.code);
    setConfirmId(`copied:${snippet.id}`);
    setTimeout(() => setConfirmId(null), 1200);
  }

  const inFormStep = !!selectedSnippet && !!selectedSchema;

  // Built once and then framed, rather than wrapped in a component declared
  // during render — that remounts the whole subtree on every render.
  const body = (
    <>
      {inFormStep ? (
        <SnippetParamsForm
          schema={selectedSchema!}
          onBack={() => setSelectedId(null)}
          onInsert={handleInsert}
        />
      ) : (
        <div className="vt-scroll" style={{ overflowY: "auto", maxHeight: 560 }}>
          <div style={{ padding: "16px 20px", borderBottom: "0.5px solid var(--line-1)" }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
              Self-contained Remotion scenes with Apify branding baked in. Pick one to fill in your
              text and values — the snippet is generated deterministically, no AI required.
              {hasExistingCode && (
                <span style={{ color: "var(--text-1)" }}>
                  {" "}This project already has code — inserting will replace it (you can undo).
                </span>
              )}
            </p>
          </div>

          {loading && (
            <div style={{ padding: 28, textAlign: "center", color: "var(--text-3)", fontSize: 12 }}>
              Loading…
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, padding: 20 }}>
            {snippets.map((s) => {
              const accent = PREVIEW_COLORS[s.id] ?? BRAND.colors.orange;
              const icon = SNIPPET_ICONS[s.id] ?? "film";
              const justCopied = confirmId === `copied:${s.id}`;
              return (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    padding: 14,
                    background: "var(--bg-inset)",
                    border: "0.5px solid var(--line-2)",
                    borderRadius: "var(--r-md)",
                  }}
                >
                  <div
                    style={{
                      aspectRatio: "16 / 9",
                      borderRadius: "var(--r-sm)",
                      background: BRAND.colors.bg,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "column",
                      gap: 8,
                      border: `0.5px solid ${accent}33`,
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 10,
                        background: `${accent}22`,
                        border: `0.5px solid ${accent}55`,
                        display: "grid",
                        placeItems: "center",
                        color: accent,
                      }}
                    >
                      <Icon name={icon} size={18} />
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-0)",
                        letterSpacing: "-0.01em",
                      }}
                    >
                      {s.name}
                    </div>
                    <div
                      style={{
                        position: "absolute",
                        bottom: 8,
                        right: 8,
                        width: 24,
                        height: 2,
                        background: accent,
                        borderRadius: 1,
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-0)" }}>
                      {s.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.4 }}>
                      {s.subtitle}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                    <button
                      onClick={() => handleSelect(s)}
                      style={{
                        flex: 1,
                        height: 28,
                        padding: "0 10px",
                        background: "var(--accent)",
                        color: "var(--accent-ink)",
                        border: "none",
                        borderRadius: "var(--r-sm)",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                      }}
                    >
                      <Icon name="plus" size={11} />
                      Use as scene
                    </button>
                    <button
                      onClick={() => copySource(s)}
                      title="Copy raw source to clipboard"
                      style={{
                        height: 28,
                        padding: "0 10px",
                        background: "var(--bg-3)",
                        color: justCopied ? "var(--accent)" : "var(--text-1)",
                        border: "0.5px solid var(--line-2)",
                        borderRadius: "var(--r-sm)",
                        fontSize: 11,
                        fontWeight: 500,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      <Icon name={justCopied ? "check" : "code"} size={11} />
                      {justCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {confirmId === "__pending__" && (
        <div
          onClick={cancelReplace}
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
              The customized snippet will replace what&rsquo;s currently in the editor. You can undo
              with Cmd+Z.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={cancelReplace}
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
                onClick={confirmReplace}
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
    </>
  );

  return inline ? (
    <div className="vt-scroll" style={{ height: "100%", overflowY: "auto", minHeight: 0 }}>{body}</div>
  ) : (
    <Modal
      open={open}
      onClose={onClose}
      width={760}
      title={inFormStep ? selectedSnippet!.name : "Brand snippets"}
      stepLabel={inFormStep ? "Customize parameters" : "Apify-branded scenes"}
    >
      {body}
    </Modal>
  );
}
