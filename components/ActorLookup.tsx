"use client";

import React, { useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";

// Apify Store lookup shown above the Actor-card form. Type a name (or paste a
// Store URL / handle), pick a result, and it fills every field — including the
// Actor icon and author avatar as embedded data URIs — via onPick(patch), where
// patch keys are the snippet's param names. Mirrors the Figma "Apify plugin":
// the actual data comes from Apify Store's public index via /api/apify-actor.

interface Candidate {
  title: string;
  handle: string;
  username: string;
  name: string;
  iconUrl: string;
}

interface CardResponse {
  title: string;
  handle: string;
  description: string;
  authorName: string;
  ratingValue: string;
  reviewCount: string;
  usersLabel: string;
  iconDataUri: string;
  avatarDataUri: string;
}

interface ActorLookupProps {
  onPick: (patch: Record<string, unknown>) => void;
}

function looksLikeRef(q: string): boolean {
  return /apify\.com/i.test(q) || /^[a-z0-9_.-]+[/~][a-z0-9_.-]+$/i.test(q.trim());
}

export default function ActorLookup({ onPick }: ActorLookupProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q || looksLikeRef(q)) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/apify-actor?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        if (id !== seq.current) return;
        setResults(Array.isArray(data.results) ? data.results : []);
        setOpen(true);
      } catch {
        if (id === seq.current) setError("Search failed — check your connection.");
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function pick(ref: string, label: string) {
    setResolving(ref);
    setError(null);
    try {
      const r = await fetch(`/api/apify-actor?resolve=${encodeURIComponent(ref)}`);
      if (!r.ok) throw new Error();
      const card = (await r.json()) as CardResponse;
      onPick({
        ACTOR_TITLE: card.title,
        ACTOR_HANDLE: card.handle,
        ACTOR_DESC: card.description,
        AUTHOR_NAME: card.authorName,
        ACTOR_ICON: card.iconDataUri ? [card.iconDataUri] : [],
        AUTHOR_AVATAR: card.avatarDataUri ? [card.avatarDataUri] : [],
      });
      setLoaded(card.handle || label);
      setOpen(false);
      setResults([]);
    } catch {
      setError("Couldn't load that Actor — try another, or paste its Store URL.");
    } finally {
      setResolving(null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (looksLikeRef(q)) pick(q, q);
    else if (results[0]) pick(results[0].handle, results[0].title);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        background: "var(--bg-inset)",
        border: "0.5px solid var(--line-2)",
        borderRadius: "var(--r-sm)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="sparkle" size={12} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-1)",
            letterSpacing: "0.01em",
            textTransform: "uppercase",
          }}
        >
          Search the Apify Store
        </span>
        {/* The field has always searched; the heading said "fill", which read as
            paste-a-link-here and hid it. */}
        <span style={{ fontSize: 10, color: "var(--text-3)", textTransform: "none", letterSpacing: 0 }}>
          by name, or paste a link
        </span>
      </div>

      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)" }}>
          <Icon name={loading || resolving ? "dots" : "search"} size={13} />
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLoaded(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search an Actor, or paste a Store URL / handle…"
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--bg-2)",
            border: "0.5px solid var(--line-2)",
            borderRadius: "var(--r-sm)",
            padding: "8px 10px 8px 28px",
            fontSize: 12,
            color: "var(--text-0)",
            fontFamily: "inherit",
            outline: "none",
          }}
        />

        {open && results.length > 0 && (
          <div
            className="vt-scroll"
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 20,
              maxHeight: 244,
              overflowY: "auto",
              background: "var(--bg-2)",
              border: "0.5px solid var(--line-2)",
              borderRadius: "var(--r-sm)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              padding: 4,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {results.map((c) => (
              <button
                key={c.handle}
                type="button"
                onClick={() => pick(c.handle, c.title)}
                disabled={!!resolving}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 8px",
                  background: "transparent",
                  border: "none",
                  borderRadius: "var(--r-sm)",
                  cursor: resolving ? "wait" : "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-3)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 7,
                    flexShrink: 0,
                    overflow: "hidden",
                    background: "var(--bg-inset)",
                    border: "0.5px solid var(--line-2)",
                  }}
                >
                  {c.iconUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.iconUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text-0)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {c.title}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "ui-monospace, monospace",
                      color: "var(--text-2)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {c.handle}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <span style={{ fontSize: 11, color: "var(--danger, #e5484d)", lineHeight: 1.4 }}>{error}</span>}
      {loaded && !error && (
        <span style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.4, display: "flex", alignItems: "center", gap: 5 }}>
          <Icon name="check" size={12} />
          Loaded <strong style={{ color: "var(--text-1)", fontWeight: 600 }}>{loaded}</strong> — fields below are filled and editable.
        </span>
      )}
    </div>
  );
}
