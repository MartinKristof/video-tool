"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import ProjectCard from "@/components/ProjectCard";
import NewProjectModal from "@/components/NewProjectModal";
import StorageModal from "@/components/StorageModal";
import TypeTile from "@/components/TypeTile";
import Logo from "@/components/ui/Logo";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";
import Modal from "@/components/ui/Modal";
import type { ProjectMeta, AnimationType, Collection } from "@/lib/types";
import { ANIMATION_TYPES, getAnimationTypeMeta, normalizeAnimationType } from "@/lib/animation-types";
import { version as APP_VERSION } from "../package.json";

/**
 * The whole workspace: the type picker, one type's projects, and a collection.
 *
 * Which of the three you see is decided by the URL rather than by state, so the
 * back button, a bookmark and a pasted link all work. The routes under app/ are
 * thin wrappers that pass what they matched; everything else lives here.
 */
export default function Workspace({
  type = null,
  collectionId = null,
}: {
  type?: AnimationType | null;
  collectionId?: string | null;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const selectedType = type;
  // Resolved from the id in the URL once collections land, so a deep link to a
  // collection works before anything has been clicked.
  const selectedCollection = collectionId
    ? collections.find((c) => c.id === collectionId) ?? null
    : null;
  const setSelectedType = (t: AnimationType | null) => router.push(t ? `/${t}` : "/");
  const setSelectedCollection = (c: Collection | null) =>
    router.push(c ? `/collection/${c.id}` : "/");
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ProjectMeta | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);

  async function fetchProjects() {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setProjects(data);
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState runs after the await, not synchronously
    fetchProjects();
    fetch("/api/collections")
      .then((r) => r.json())
      .then(setCollections)
      .catch((err) => console.error("Failed to load collections:", err));
  }, []);

  // Cmd+N opens the modal (only meaningful once a type is chosen)
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "n" && selectedType) {
        e.preventDefault();
        setModalOpen(true);
      }
      if (e.key === "Escape" && selectedType && !modalOpen && !deleteConfirm) {
        setSelectedType(null);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedType, modalOpen, deleteConfirm]);

  // Prompts for a name and creates a collection; returns it (or null if cancelled).
  async function createCollection(): Promise<Collection | null> {
    const name = window.prompt("Collection name");
    if (!name || !name.trim()) return null;
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) return null;
      const col: Collection = await res.json();
      setCollections((prev) => [col, ...prev]);
      return col;
    } catch (err) {
      console.error("Failed to create collection:", err);
      return null;
    }
  }

  async function assignToCollection(projectId: string, collectionId: string | null) {
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionId }),
      });
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, collectionId: collectionId ?? undefined } : p))
      );
    } catch (err) {
      console.error("Failed to assign collection:", err);
    }
  }

  async function assignNewCollection(projectId: string) {
    const col = await createCollection();
    if (col) assignToCollection(projectId, col.id);
  }

  async function renameCollection(col: Collection) {
    const name = window.prompt("Rename collection", col.name);
    if (!name || !name.trim()) return;
    try {
      const res = await fetch(`/api/collections/${col.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) return;
      const updated: Collection = await res.json();
      setCollections((prev) => prev.map((c) => (c.id === col.id ? updated : c)));
    } catch (err) {
      console.error("Failed to rename collection:", err);
    }
  }

  async function deleteCollectionFlow(col: Collection) {
    if (!window.confirm(`Delete collection "${col.name}"? Its projects are kept, just ungrouped.`)) return;
    try {
      await fetch(`/api/collections/${col.id}`, { method: "DELETE" });
      setCollections((prev) => prev.filter((c) => c.id !== col.id));
      router.push("/");
      fetchProjects(); // members lost their collectionId server-side
    } catch (err) {
      console.error("Failed to delete collection:", err);
    }
  }

  async function handleDuplicate(id: string) {
    try {
      const res = await fetch(`/api/projects/${id}/duplicate`, { method: "POST" });
      if (!res.ok) return;
      const newProject = await res.json();
      router.push(`/project/${newProject.id}`);
    } catch (err) {
      console.error("Failed to duplicate project:", err);
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setDeleteConfirm(null);
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  }

  function handleCreated({
    projectId,
    autoAction,
  }: {
    projectId: string;
    autoAction?: "smarttrim" | "compose";
  }) {
    setModalOpen(false);
    const suffix = autoAction ? `?action=${autoAction}` : "";
    router.push(`/project/${projectId}${suffix}`);
  }

  const countsByType = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of projects) {
      const id = normalizeAnimationType(p.animationType);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [projects]);

  const countsByCollection = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of projects) {
      if (p.collectionId) counts[p.collectionId] = (counts[p.collectionId] ?? 0) + 1;
    }
    return counts;
  }, [projects]);

  // ───── Opening screen: type picker ─────
  // A selected collection takes precedence over the type picker, so clicking a
  // collection card from the workspace (where selectedType is still null) opens
  // the collection-detail screen below instead of re-rendering this picker.
  if (selectedType === null && !selectedCollection) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-1)" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            padding: "16px 28px",
            borderBottom: "0.5px solid var(--line-1)",
          }}
        >
          <Logo />
          <div style={{ flex: 1 }} />
          <div className="mono" style={{ fontSize: 11, color: "var(--text-2)", marginRight: 10 }}>
            {projects.length} {projects.length === 1 ? "project" : "projects"} · v{APP_VERSION}
          </div>
          <Button variant="ghost" size="sm" icon="folder" onClick={() => setStorageOpen(true)}>
            Storage
          </Button>
        </header>

        <StorageModal
          open={storageOpen}
          onClose={() => setStorageOpen(false)}
          onProjectsDeleted={() => fetchProjects()}
        />

        <div
          style={{
            maxWidth: 980,
            margin: "0 auto",
            padding: "64px 28px 40px",
            display: "flex",
            flexDirection: "column",
            gap: 32,
          }}
        >
          <div>
            <div className="mono cap" style={{ color: "var(--text-2)", marginBottom: 10 }}>
              Workspace
            </div>
            <h1 style={{ margin: 0, fontSize: 36, letterSpacing: -0.8, fontWeight: 600 }}>
              What are you making?
            </h1>
            <p style={{ margin: "10px 0 0", color: "var(--text-1)", fontSize: 14, maxWidth: 560 }}>
              Pick a style to see past projects or start a new one.
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            {ANIMATION_TYPES.map((t) => (
              <TypeTile
                key={t.id}
                type={t.id}
                size="lg"
                count={countsByType[t.id] ?? 0}
                onClick={() => setSelectedType(t.id)}
              />
            ))}
          </div>

          {/* Collections — cross-type groups (e.g. all clips for one video) */}
          <div>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <div className="mono cap" style={{ color: "var(--text-2)" }}>
                Collections
              </div>
              <div style={{ flex: 1 }} />
              <Button variant="ghost" size="sm" icon="plus" onClick={createCollection}>
                New collection
              </Button>
            </div>
            {collections.length === 0 ? (
              <p className="mono" style={{ fontSize: 11, color: "var(--text-3)", margin: 0 }}>
                Group projects from any type into one collection — handy when several clips make one video.
              </p>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: 12,
                }}
              >
                {collections.map((col) => (
                  <button
                    key={col.id}
                    onClick={() => setSelectedCollection(col)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "14px 16px",
                      background: "var(--bg-2)",
                      border: "0.5px solid var(--line-2)",
                      borderRadius: "var(--r-md)",
                      cursor: "pointer",
                      textAlign: "left",
                      color: "var(--text-0)",
                      transition: "border-color 120ms",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line-2)")}
                  >
                    <Icon name="folder" size={16} style={{ color: "var(--accent)" }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {col.name}
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--text-2)" }}>
                        {countsByCollection[col.id] ?? 0} {(countsByCollection[col.id] ?? 0) === 1 ? "project" : "projects"}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ───── Collection detail screen: cross-type projects in one collection ─────
  if (selectedCollection) {
    const inCollection = projects.filter((p) => p.collectionId === selectedCollection.id);
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-1)" }}>
        <header
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            padding: "16px 28px",
            background: "color-mix(in oklab, var(--bg-1) 85%, transparent)",
            backdropFilter: "blur(12px)",
            borderBottom: "0.5px solid var(--line-1)",
          }}
        >
          <Logo onClick={() => setSelectedCollection(null)} />
          <button
            onClick={() => setSelectedCollection(null)}
            className="mono"
            style={{
              marginLeft: 18,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              background: "transparent",
              border: "0.5px solid var(--line-2)",
              borderRadius: 4,
              color: "var(--text-1)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            <Icon name="arrowLeft" size={11} />
            Workspace
          </button>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-2)", marginRight: 8 }}>
              {inCollection.length} {inCollection.length === 1 ? "project" : "projects"}
            </div>
            <Button variant="ghost" size="sm" icon="copy" onClick={() => renameCollection(selectedCollection)}>
              Rename
            </Button>
            <Button variant="ghost" size="sm" icon="trash" onClick={() => deleteCollectionFlow(selectedCollection)}>
              Delete
            </Button>
          </div>
        </header>

        <div style={{ padding: "36px 28px 20px", borderBottom: "0.5px solid var(--line-1)" }}>
          <div className="mono cap" style={{ color: "var(--accent)", marginBottom: 8 }}>
            Collection
          </div>
          <h1 style={{ margin: 0, fontSize: 32, letterSpacing: -0.8, fontWeight: 600 }}>
            {selectedCollection.name}
          </h1>
          <p style={{ margin: "6px 0 0", color: "var(--text-1)", fontSize: 14, maxWidth: 520 }}>
            Projects of any type grouped under this collection.
          </p>
        </div>

        {inCollection.length === 0 ? (
          <div style={{ padding: "48px 28px", color: "var(--text-2)", fontSize: 13 }}>
            No projects here yet. Open a project&apos;s menu (the folder icon on its card) to add it to{" "}
            <span style={{ color: "var(--text-0)", fontWeight: 500 }}>{selectedCollection.name}</span>.
          </div>
        ) : (
          <div
            style={{
              padding: 28,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 20,
            }}
          >
            {inCollection.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                collections={collections}
                onClick={() => router.push(`/project/${project.id}`)}
                onDelete={() => setDeleteConfirm(project)}
                onDuplicate={() => handleDuplicate(project.id)}
                onAssignCollection={(cid) => assignToCollection(project.id, cid)}
                onCreateCollection={() => assignNewCollection(project.id)}
              />
            ))}
          </div>
        )}

        <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} width={380}>
          <div style={{ padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Delete this project?</div>
            <div style={{ fontSize: 12.5, color: "var(--text-1)", lineHeight: 1.5, marginBottom: 18 }}>
              <span style={{ color: "var(--text-0)", fontWeight: 500 }}>{deleteConfirm?.name}</span> will be
              permanently removed. This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => deleteConfirm && handleDelete(deleteConfirm.id)}>
                Delete
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  // ───── Per-type screen: filtered projects + new-project tile ─────
  // Unreachable: the picker above returns whenever selectedType is null and no
  // collection is selected, and the collection screen returns whenever one is.
  // TypeScript can't narrow across that compound guard, so state it explicitly
  // rather than assert with `!` — this is what broke `next build`.
  if (selectedType === null) return null;
  const meta = getAnimationTypeMeta(selectedType);
  // Normalised so the merged Animation tile lists the 123 legacy "broll"
  // projects alongside the rest — they are the same thing.
  const filtered = projects.filter((p) => normalizeAnimationType(p.animationType) === selectedType);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-1)" }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          padding: "16px 28px",
          background: "color-mix(in oklab, var(--bg-1) 85%, transparent)",
          backdropFilter: "blur(12px)",
          borderBottom: "0.5px solid var(--line-1)",
        }}
      >
        <Logo onClick={() => setSelectedType(null)} />
        <button
          onClick={() => setSelectedType(null)}
          className="mono"
          style={{
            marginLeft: 18,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            background: "transparent",
            border: "0.5px solid var(--line-2)",
            borderRadius: 4,
            color: "var(--text-1)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          <Icon name="arrowLeft" size={11} />
          All types
        </button>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--text-2)", marginRight: 8 }}>
            {filtered.length} {filtered.length === 1 ? "project" : "projects"} · v{APP_VERSION}
          </div>
          <Button variant="ghost" size="sm" icon="folder" onClick={() => setStorageOpen(true)}>
            Storage
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setModalOpen(true)}>
            New {meta.label} project
          </Button>
        </div>
      </header>

      <div
        style={{
          padding: "36px 28px 20px",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          borderBottom: "0.5px solid var(--line-1)",
        }}
      >
        <div>
          <div
            className="mono cap"
            style={{ color: meta.color, marginBottom: 8 }}
          >
            {meta.badgeLabel}
          </div>
          <h1 style={{ margin: 0, fontSize: 32, letterSpacing: -0.8, fontWeight: 600 }}>
            {meta.label} projects
          </h1>
          <p style={{ margin: "6px 0 0", color: "var(--text-1)", fontSize: 14, maxWidth: 520 }}>
            {meta.subtitle}.
          </p>
        </div>
      </div>

      <div
        style={{
          padding: 28,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 20,
        }}
      >
        {/* Only the dashed tile shows on a fresh install, which says nothing about
            how to start — and ⌘N was documented nowhere in the app. */}
        {filtered.length === 0 && (
          <div style={{ gridColumn: "1 / -1", fontSize: 13, color: "var(--text-2)", marginBottom: -4 }}>
            No {meta.label.toLowerCase()} projects yet. Start one below, or press{" "}
            <span className="mono" style={{ color: "var(--text-1)" }}>⌘N</span>.
          </div>
        )}
        {filtered.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            collections={collections}
            onClick={() => router.push(`/project/${project.id}`)}
            onDelete={() => setDeleteConfirm(project)}
            onDuplicate={() => handleDuplicate(project.id)}
            onAssignCollection={(cid) => assignToCollection(project.id, cid)}
            onCreateCollection={() => assignNewCollection(project.id)}
          />
        ))}

        <button
          onClick={() => setModalOpen(true)}
          style={{
            aspectRatio: "1 / 1.15",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            background: "transparent",
            border: "1px dashed var(--line-2)",
            borderRadius: "var(--r-md)",
            cursor: "pointer",
            color: "var(--text-2)",
            transition: "border-color 120ms, color 120ms",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = meta.color;
            e.currentTarget.style.color = meta.color;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--line-2)";
            e.currentTarget.style.color = "var(--text-2)";
          }}
        >
          <Icon name="plus" size={22} />
          <span style={{ fontSize: 12 }}>New {meta.label} project</span>
        </button>
      </div>

      <NewProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        initialType={selectedType}
        onCreated={handleCreated}
      />

      <StorageModal
        open={storageOpen}
        onClose={() => setStorageOpen(false)}
        onProjectsDeleted={() => fetchProjects()}
      />

      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} width={380}>
        <div style={{ padding: 24 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              background: "var(--red-soft)",
              display: "grid",
              placeItems: "center",
              color: "var(--red)",
              marginBottom: 14,
            }}
          >
            <Icon name="trash" size={16} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Delete this project?</div>
          <div style={{ fontSize: 12.5, color: "var(--text-1)", lineHeight: 1.5, marginBottom: 18 }}>
            <span style={{ color: "var(--text-0)", fontWeight: 500 }}>{deleteConfirm?.name}</span> and its chat
            history will be permanently removed. This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => deleteConfirm && handleDelete(deleteConfirm.id)}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
