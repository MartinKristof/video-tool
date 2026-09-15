/**
 * Lightweight parser for Charm VHS .tape scripts.
 *
 * Turns a `.tape` source into a sequence of timed events (in ms) so the
 * terminal timeline UI can show what's happening when. We don't try to be
 * byte-accurate against VHS itself — close enough that markers line up with
 * the rendered MP4 to within a frame or two at typical fps.
 *
 * Reference: https://github.com/charmbracelet/vhs
 */

export type TapeEventKind = "type" | "sleep" | "key" | "set" | "comment" | "unknown";

export interface TapeEvent {
  kind: TapeEventKind;
  // ms into the recording at which this event starts.
  startMs: number;
  // ms this event consumes. 0 for Set/comment lines.
  durationMs: number;
  // For Type events, the literal text being typed.
  text?: string;
  // For Key events, the key name (Enter, Backspace, Ctrl+C, ...).
  key?: string;
  // The original line as written in the .tape file (trimmed).
  raw: string;
  // 1-based line number in the source.
  sourceLine: number;
}

// VHS defaults (https://github.com/charmbracelet/vhs#settings).
const DEFAULT_TYPING_SPEED_MS = 50;
// Keystrokes outside of Type (Enter, Backspace, etc.) — VHS uses ~50ms by
// default for these too. Sleep and Type each have explicit durations.
const DEFAULT_KEY_MS = 50;

function parseDurationToken(token: string | undefined): number | null {
  if (!token) return null;
  const m = token.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  return n;
}

function parseQuotedString(rest: string): string | null {
  // Accepts "..." or '...' or `...`. Returns the unescaped content (no quote handling deeper than \\\" / \\').
  const trimmed = rest.trim();
  if (!trimmed) return null;
  const q = trimmed[0];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  // find closing quote that isn't escaped
  let i = 1;
  let out = "";
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (c === "\\" && i + 1 < trimmed.length) {
      out += trimmed[i + 1];
      i += 2;
      continue;
    }
    if (c === q) return out;
    out += c;
    i++;
  }
  return null;
}

export interface ParsedTape {
  events: TapeEvent[];
  totalDurationMs: number;
  typingSpeedMs: number;
}

/**
 * Rewrite `Type "..."` lines so they use a quote style VHS actually accepts.
 *
 * VHS does NOT support backslash-escapes inside its string literals — `\"`
 * inside a double-quoted Type string is treated as two tokens (a literal `\`
 * followed by an unterminated string) and the line fails to parse. The fix is
 * to swap the outer quote style:
 *   - if the text has " but no ' → use single quotes
 *   - if the text has '  but no " → use double quotes (default)
 *   - if the text has both → use backticks
 *
 * The LLM occasionally emits `Type "...\"...\""` despite prompt guidance, so we
 * normalize on receipt instead of relying on the model alone.
 */
export function normalizeTapeQuotes(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      // Match optional leading whitespace + Type + the first quoted argument.
      // We only rewrite when the captured body actually contains `\"` or `\'`
      // — i.e. the AI tried to escape and produced something VHS can't parse.
      const m = line.match(/^(\s*Type\s+)(["'`])((?:\\.|(?!\2).)*)\2(.*)$/);
      if (!m) return line;
      const [, prefix, , body, trailing] = m;
      if (!/\\["'`]/.test(body)) return line; // no escaped quote, nothing to fix
      // Reverse the escapes to recover the literal intent.
      const literal = body.replace(/\\(["'`])/g, "$1");
      const hasDouble = literal.includes('"');
      const hasSingle = literal.includes("'");
      const hasBacktick = literal.includes("`");
      let outer: '"' | "'" | "`";
      if (!hasDouble) outer = '"';
      else if (!hasSingle) outer = "'";
      else if (!hasBacktick) outer = "`";
      else {
        // Pathological — text contains all three. Fall back to single quotes
        // with the inner singles stripped, so the line at least parses.
        return `${prefix}'${literal.replace(/'/g, "")}'${trailing}`;
      }
      return `${prefix}${outer}${literal}${outer}${trailing}`;
    })
    .join("\n");
}

export function parseTape(source: string): ParsedTape {
  const lines = source.split(/\r?\n/);
  const events: TapeEvent[] = [];
  let cursorMs = 0;
  let typingSpeedMs = DEFAULT_TYPING_SPEED_MS;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    const lineNo = idx + 1;
    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      events.push({ kind: "comment", startMs: cursorMs, durationMs: 0, raw: trimmed, sourceLine: lineNo });
      continue;
    }

    // Set <Name> <value>
    if (/^Set\s+/i.test(trimmed)) {
      const setMatch = trimmed.match(/^Set\s+(\S+)\s+(.*)$/i);
      if (setMatch && /^TypingSpeed$/i.test(setMatch[1])) {
        const v = parseDurationToken(setMatch[2]);
        if (v != null && v >= 0) typingSpeedMs = v;
      }
      events.push({ kind: "set", startMs: cursorMs, durationMs: 0, raw: trimmed, sourceLine: lineNo });
      continue;
    }

    // Sleep <duration>
    if (/^Sleep\s+/i.test(trimmed)) {
      const m = trimmed.match(/^Sleep\s+(\S+)/i);
      const ms = m ? parseDurationToken(m[1]) : null;
      const duration = ms ?? 0;
      events.push({ kind: "sleep", startMs: cursorMs, durationMs: duration, raw: trimmed, sourceLine: lineNo });
      cursorMs += duration;
      continue;
    }

    // Type "..." [@speed]?  — speed override is uncommon; we ignore it for now.
    if (/^Type\s+/i.test(trimmed)) {
      const after = trimmed.replace(/^Type\s+/i, "");
      const text = parseQuotedString(after);
      if (text != null) {
        const duration = text.length * typingSpeedMs;
        events.push({
          kind: "type",
          startMs: cursorMs,
          durationMs: duration,
          text,
          raw: trimmed,
          sourceLine: lineNo,
        });
        cursorMs += duration;
      } else {
        events.push({ kind: "unknown", startMs: cursorMs, durationMs: 0, raw: trimmed, sourceLine: lineNo });
      }
      continue;
    }

    // Single-keystroke commands: Enter, Backspace [n], Tab, Space, Up/Down/Left/Right, Escape, PageUp/PageDown,
    // Ctrl+<key>, Alt+<key>, Shift+<key>. We treat each as DEFAULT_KEY_MS, and Backspace N as N keystrokes.
    const keyMatch = trimmed.match(
      /^(Enter|Backspace|Tab|Space|Up|Down|Left|Right|Escape|PageUp|PageDown|Home|End|Delete|Insert|Ctrl\+[A-Za-z0-9]+|Alt\+[A-Za-z0-9]+|Shift\+[A-Za-z0-9]+|Hide|Show|Screenshot|Output|Source|Require|Wait)\s*(\d+)?\s*$/i,
    );
    if (keyMatch) {
      const key = keyMatch[1];
      const count = keyMatch[2] ? Math.max(1, parseInt(keyMatch[2], 10)) : 1;
      // Hide / Show / Screenshot / Output / Source / Require / Wait don't consume time.
      const isInstant = /^(Hide|Show|Screenshot|Output|Source|Require|Wait)$/i.test(key);
      const duration = isInstant ? 0 : DEFAULT_KEY_MS * count;
      events.push({
        kind: isInstant ? "set" : "key",
        startMs: cursorMs,
        durationMs: duration,
        key,
        raw: trimmed,
        sourceLine: lineNo,
      });
      cursorMs += duration;
      continue;
    }

    // Anything else: keep a marker so the timeline can still show "something here", but assume 0 duration.
    events.push({ kind: "unknown", startMs: cursorMs, durationMs: 0, raw: trimmed, sourceLine: lineNo });
  }

  return { events, totalDurationMs: cursorMs, typingSpeedMs };
}
