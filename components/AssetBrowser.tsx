"use client";

import React, { useState, useEffect, useRef } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";

interface AssetItem {
  name: string;
  path: string;
  type: "image" | "svg" | "video" | "other";
}

interface AssetGroup {
  folder: string;
  items: AssetItem[];
}

interface AssetBrowserProps {
  open: boolean;
  onClose: () => void;
  onCopyPath: (path: string) => void;
  /**
   * Render as a panel instead of a modal, for use as a tab. The body is
   * identical either way — only the frame around it changes.
   */
  inline?: boolean;
  /**
   * When given, clicking a tile calls this instead of copying its
   * `staticFile()` path. In the visual editor an asset should land on a track;
   * copying a path to the clipboard is the code editor's idiom.
   */
  onInsert?: (path: string, type: string) => void;
}

export default function AssetBrowser({ open, onClose, onCopyPath, inline, onInsert }: AssetBrowserProps) {
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderRef = useRef<string>("");

  useEffect(() => {
    // As a tab there is no `open` to wait for — it is mounted or it isn't.
    if (open || inline) fetchAssets();
  }, [open, inline]);

  function fetchAssets() {
    fetch("/api/assets")
      .then((r) => r.json())
      .then(setGroups)
      .catch(console.error);
  }

  function handleCopy(assetPath: string) {
    const snippet = `staticFile("${assetPath}")`;
    navigator.clipboard.writeText(snippet);
    onCopyPath(snippet);
    setCopiedPath(assetPath);
    setTimeout(() => setCopiedPath(null), 1500);
  }

  function triggerUpload(folder: string) {
    uploadFolderRef.current = folder;
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const folder = uploadFolderRef.current;
    setUploading(folder);

    try {
      const formData = new FormData();
      formData.append("folder", folder);
      formData.append("file", file);

      const res = await fetch("/api/assets", { method: "POST", body: formData });
      if (res.ok) {
        fetchAssets();
      }
    } catch (err) {
      console.error("Upload failed:", err);
    } finally {
      setUploading(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Built once and then framed, rather than wrapped in a component declared
  // during render — that remounts the whole subtree on every render.
  const body = (
    <>
      <div className="vt-scroll" style={{ overflowY: "auto", height: inline ? "100%" : undefined, maxHeight: inline ? undefined : 560 }}>
        {groups.map((group) => (
          <div key={group.folder} style={{ padding: "16px 20px", borderBottom: "0.5px solid var(--line-1)" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <Icon name="folder" size={13} style={{ color: "var(--text-2)", marginRight: 7 }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{group.folder}</span>
              <span className="mono nums" style={{ fontSize: 10, color: "var(--text-3)", marginLeft: 8 }}>
                {group.items.length}
              </span>
              <div style={{ flex: 1 }} />
              <Button
                variant="ghost"
                size="sm"
                icon="upload"
                onClick={() => triggerUpload(group.folder)}
                disabled={uploading === group.folder}
              >
                {uploading === group.folder ? "Uploading..." : "Upload"}
              </Button>
            </div>

            {group.items.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
                {group.items.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => (onInsert ? onInsert(item.path, item.type) : handleCopy(item.path))}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      textAlign: "left",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        aspectRatio: "1 / 1",
                        borderRadius: "var(--r-sm)",
                        border: "0.5px solid var(--line-2)",
                        overflow: "hidden",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "var(--bg-inset)",
                      }}
                    >
                      {item.type === "image" || item.type === "svg" ? (
                        <img
                          src={`/${item.path}`}
                          alt={item.name}
                          style={{ maxWidth: "80%", maxHeight: "80%", objectFit: "contain" }}
                        />
                      ) : (
                        <span style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase" }}>
                          {item.type}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span
                        className="mono"
                        style={{
                          fontSize: 10,
                          color: copiedPath === item.path ? "var(--accent)" : "var(--text-1)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                      >
                        {copiedPath === item.path ? "Copied!" : item.name}
                      </span>
                      {copiedPath === item.path && (
                        <Icon name="check" size={10} style={{ color: "var(--accent)" }} />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ padding: "14px 0", textAlign: "center" }}>
                <span style={{ fontSize: 10, color: "var(--text-3)" }}>No assets yet</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".png,.svg,.jpg,.jpeg,.webp,.gif"
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />
    </>
  );

  return inline ? (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>{body}</div>
  ) : (
    <Modal open={open} onClose={onClose} width={760} title="Asset library" stepLabel="Project files">
      {body}
    </Modal>
  );
}
