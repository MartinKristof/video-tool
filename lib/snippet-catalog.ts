import fs from "fs";
import path from "path";
import { SNIPPET_SCHEMAS, type Param, type SnippetSchema } from "./snippet-schemas";
import { sceneMeta } from "./scene-eval";

/**
 * The branded scene library, as one list.
 *
 * It used to be described in three places that disagreed: 29 files on disk, 21
 * with a display name in the snippets route, and 25 with a parameter schema. Of
 * those, only 19 were complete — and five (AccountCTA, ActorStoreCard,
 * ChartReveal, EventContour, HiringCard) have a schema but no name, so they do
 * not appear in the Snippets browser at all despite being fully built.
 *
 * Reading the directory is the source of truth for WHAT EXISTS; the name and the
 * schema are looked up and may be missing. A scene with no schema can still be
 * placed, it just has no parameters to fill in.
 */

/** Display names. A scene missing one is still usable — its id is the fallback. */
export const SNIPPET_META: Record<string, { name: string; subtitle: string }> = {
  IntroCard: { name: "Intro card", subtitle: "Wordmark + headline with highlighted phrase" },
  LowerThird: { name: "Lower third", subtitle: "Name tag with orange accent rule (single or dual)" },
  EndCard: { name: "End card", subtitle: "Outlined CTA pill + QR + promo code" },
  StatCallout: { name: "Stat callout", subtitle: "Big animated number with orange highlight" },
  QuoteCard: { name: "Quote card", subtitle: "Testimonial card with orange quotemark" },
  LogoBumper: { name: "Logo bumper", subtitle: "Apify symbol reveal — opener/closer" },
  CalloutBanner: { name: "Callout banner", subtitle: "Headline strip overlay with highlighted phrase" },
  ListReveal: { name: "List reveal", subtitle: "Checkmark feature list inside a card" },
  CodeSnippet: { name: "Code snippet", subtitle: "Editor card — monochrome orange syntax" },
  SymbolBug: { name: "Symbol bug", subtitle: "Corner watermark — overlay this on footage" },
  PathReveal: { name: "Path reveal", subtitle: "Headline with hand-drawn orange underline" },
  RisingStarsList: { name: "Rising Stars list", subtitle: "Numbered Actor cards + corner wedge" },
  LogoGridStrip: { name: "Logo grid", subtitle: '"Works with" partner-logo strip' },
  FourQuadrant: { name: "Four quadrants", subtitle: "2×2 feature-card grid with partner row" },
  BeforeAfter: { name: "Before / after", subtitle: "Stacked comparison cards" },
  EventCard: { name: "Event card", subtitle: "Event title + date + sponsor logo" },
  MCPLaunchFrame: { name: "MCP launch frame", subtitle: "Schematic-style line-draw frame" },
  PromptBox: { name: "Prompt box", subtitle: "Claude composer — typewriter prompt reveal (transparent)" },
  AiChat: { name: "AI chat", subtitle: "Prompt bubble + typed answer or screenshots → Apify wordmark" },
  Years: { name: "Years", subtitle: "White year counter slides 2004 → 2014, then holds (transparent)" },
  ActorCard: { name: "Actor card", subtitle: "Apify Store Actor card — search the Store, auto-fills icon + details" },
};

export interface SnippetEntry {
  id: string;
  name: string;
  subtitle: string;
  code: string;
  schema?: SnippetSchema;
  /** As authored — converted to the document's rate when placed. */
  durationInFrames: number;
  fps: number;
}

const BRANDED_DIR = () => path.join(process.cwd(), "remotion", "scenes", "branded");

let cache: { entries: SnippetEntry[]; at: number } | null = null;
const CACHE_MS = 30_000;

/**
 * Every branded scene, with its name, schema and real length.
 *
 * The length is evaluated rather than pattern-matched — three scenes compute it,
 * and those constants are themselves parameters, so nothing static can be right.
 */
export function loadSnippetCatalog(): SnippetEntry[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.entries;

  const dir = BRANDED_DIR();
  const entries: SnippetEntry[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".tsx")) continue;
    const id = file.replace(/\.tsx$/, "");
    const code = fs.readFileSync(path.join(dir, file), "utf-8");
    const meta = sceneMeta(code);
    entries.push({
      id,
      name: SNIPPET_META[id]?.name ?? id,
      subtitle: SNIPPET_META[id]?.subtitle ?? "",
      code,
      schema: SNIPPET_SCHEMAS[id],
      durationInFrames: meta.durationInFrames,
      fps: meta.fps,
    });
  }
  cache = { entries, at: Date.now() };
  return entries;
}

/**
 * Parameters a scene accepts, described for a model.
 *
 * `images` params are deliberately omitted: they are base64 data URIs, and a
 * model filling one would push megabytes into project.json — which is rewritten
 * by the autosave every two seconds and parsed for every project on the home
 * page.
 */
export function describeParams(schema: SnippetSchema | undefined): string {
  if (!schema) return "This scene has no parameters — it is placed with its own default text.";
  const lines: string[] = [];
  for (const [key, param] of Object.entries(schema.params) as [string, Param][]) {
    if (param.kind === "images") continue;
    const bits: string[] = [param.kind];
    if (param.kind === "enum") bits.push(`one of: ${param.options.map((o) => o.value).join(", ")}`);
    if (param.kind === "array") {
      const fields = Object.keys(param.itemSchema ?? {}).join(", ");
      bits.push(`a list of objects with: ${fields}`);
    }
    const dflt = "default" in param ? JSON.stringify(param.default) : undefined;
    lines.push(`  ${key} — ${param.label ?? key} (${bits.join("; ")})${dflt ? ` default ${dflt}` : ""}`);
  }
  if (!lines.length) return "This scene has no text parameters you can set.";
  return lines.join("\n");
}

/** Keys a model may set: everything except the base64 image slots. */
export function settableKeys(schema: SnippetSchema | undefined): string[] {
  if (!schema) return [];
  return Object.entries(schema.params)
    .filter(([, p]) => (p as Param).kind !== "images")
    .map(([k]) => k);
}
