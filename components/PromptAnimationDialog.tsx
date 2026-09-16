"use client";

import React, { useRef, useState } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";

/**
 * Describe an animation and get it as a block on the timeline.
 *
 * The chat writes the project's scene; this writes ONE piece to drop on a track,
 * which is the difference between "change my video" and "add a thing to it".
 * Images come along as reference — the fastest way to say what a card should
 * look like is usually to show one.
 */
export default function PromptAnimationDialog({
  open,
  onClose,
  onGenerate,
}: {
  open: boolean;
  onClose: () => void;
  /** Resolves when the scene has been generated and placed. Throws to show an error. */
  onGenerate: (prompt: string, images: string[]) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<{ name: string; dataUri: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const next: { name: string; dataUri: string }[] = [];
    for (const file of Array.from(files).slice(0, 8)) {
      if (!file.type.startsWith("image/")) continue;
      const dataUri = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      next.push({ name: file.name, dataUri });
    }
    setImages((prev) => [...prev, ...next].slice(0, 8));
  }

  async function run() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onGenerate(prompt.trim(), images.map((i) => i.dataUri));
      setPrompt("");
      setImages([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Prompt an animation" width={520}>
      <div style={{ padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-1)" }}>
          {"It lands on a new track at the playhead, in your brand's style. Everything"}
          {" about it stays editable afterwards."}
        </div>

        <textarea
          value={prompt}
          autoFocus
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); }}
          placeholder="A title card that reads “Built on Apify data”, the last two words in orange, settling in from below…"
          rows={5}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent-line)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--line-2)"; }}
          style={{
            background: "var(--bg-inset)", border: "0.5px solid var(--line-2)",
            borderRadius: "var(--r-sm)", color: "var(--text-0)", fontSize: 13,
            padding: "9px 11px", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5,
            // The browser's own focus ring is blue, which is the one colour this
            // palette does not use.
            outline: "none",
          }}
        />

        {images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {images.map((img, i) => (
              <span
                key={i}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11,
                  background: "var(--bg-3)", border: "0.5px solid var(--line-2)",
                  borderRadius: "var(--r-sm)", padding: "3px 6px 3px 8px", color: "var(--text-1)",
                }}
              >
                {img.name}
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${img.name}`}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", display: "flex", padding: 0 }}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
          <Button variant="outline" size="sm" icon="image" onClick={() => fileRef.current?.click()} disabled={busy}>
            Add reference
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" icon="sparkle" onClick={run} disabled={!prompt.trim() || busy}>
            {busy ? "Writing it…" : "Generate"}
          </Button>
        </div>

        {busy && (
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            Writing and checking the scene — this usually takes under a minute.
          </div>
        )}
        {error && <div style={{ fontSize: 11, color: "var(--red)" }}>{error}</div>}
      </div>
    </Modal>
  );
}
