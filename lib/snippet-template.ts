// Deterministic, regex-based substitution of branded-snippet source code.
//
// Every snippet exposes its user-editable values as top-of-file `const`
// declarations following one canonical shape per type:
//
//   const NAME = "...";                 // string / enum
//   const FLAG = true;                  // boolean
//   const VALUE = 42;                   // number
//   const ITEMS: ...[] = [              // array (multi-line literal)
//     { key: "...", other: "..." },
//   ];
//
// Substituters target those shapes via line-anchored regexes. Identifiers
// that happen to match inside JSX bodies are never touched because the
// match anchors to start-of-line + the `const ` keyword.

import type { ArrayParam, Param, SnippetSchema } from "./snippet-schemas";

export function renderSnippet(
  sourceCode: string,
  schema: SnippetSchema,
  values: Record<string, unknown>,
): string {
  let out = sourceCode;
  for (const [key, param] of Object.entries(schema.params)) {
    const value = values[key];
    if (value === undefined) continue;
    out = replaceParam(out, key, param, value);
  }
  return out;
}

function replaceParam(source: string, key: string, param: Param, value: unknown): string {
  switch (param.kind) {
    case "string":
    case "enum":
      return replaceString(source, key, String(value));
    case "boolean":
      return replaceBoolean(source, key, Boolean(value));
    case "number":
      return replaceNumber(source, key, Number(value));
    case "array":
      return replaceArray(source, key, param, value as Record<string, unknown>[]);
    case "images":
      return replaceStringArray(source, key, (value as string[]) ?? []);
  }
}

// Replace a `const KEY: string[] = [ ... ];` multi-line array with a flat list of
// string literals (used for the `images` param — an array of data URIs).
function replaceStringArray(source: string, key: string, items: string[]): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(
    `^(\\s*const ${escapedKey})(\\s*:\\s*[^=]+?)?(\\s*=\\s*\\[)[\\s\\S]*?^(\\s*)(\\]\\s*;)\\s*$`,
    "m",
  );
  if (!rx.test(source)) {
    if (typeof console !== "undefined") {
      console.warn(`[snippet-template] no images/array match for const ${key}`);
    }
    return source;
  }
  return source.replace(rx, (_match, prefix, typeAnn, openEq, closeIndent, closeBracket) => {
    const inner = items.map((s) => `  ${JSON.stringify(String(s ?? ""))},`).join("\n");
    return `${prefix}${typeAnn ?? ""}${openEq}\n${inner}\n${closeIndent}${closeBracket}`;
  });
}

// Build the regex for a single-line `const KEY[: type]? = literal;` declaration.
// `valueShape` is the literal-matching fragment: e.g. `"[^"]*"`, `true|false`,
// `[\\d.+\\-eE]+`. Returns a RegExp with the full-line capture so we can rebuild
// the line while preserving the original type annotation.
function singleLineRegex(key: string, valueShape: string): RegExp {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(\\s*const ${escapedKey})(\\s*:\\s*[^=]+?)?(\\s*=\\s*)(?:${valueShape})(\\s*;)\\s*$`,
    "m",
  );
}

function replaceString(source: string, key: string, value: string): string {
  // Match canonical `const KEY = "...";` even with a TS annotation. We use
  // [\s\S]*? to allow nothing fancy inside the quotes — strings inside snippets
  // never contain raw double quotes (they'd need escaping anyway).
  const rx = singleLineRegex(key, `"[^"]*"|'[^']*'|\`[^\`]*\``);
  if (!rx.test(source)) {
    if (typeof console !== "undefined") {
      console.warn(`[snippet-template] no string match for const ${key}`);
    }
    return source;
  }
  return source.replace(rx, (_match, prefix, typeAnn, eq, semi) => {
    return `${prefix}${typeAnn ?? ""}${eq}${JSON.stringify(value)}${semi}`;
  });
}

function replaceBoolean(source: string, key: string, value: boolean): string {
  const rx = singleLineRegex(key, `true|false`);
  if (!rx.test(source)) {
    if (typeof console !== "undefined") {
      console.warn(`[snippet-template] no boolean match for const ${key}`);
    }
    return source;
  }
  return source.replace(rx, (_match, prefix, typeAnn, eq, semi) => {
    return `${prefix}${typeAnn ?? ""}${eq}${value ? "true" : "false"}${semi}`;
  });
}

function replaceNumber(source: string, key: string, value: number): string {
  // Allow Number literals with optional sign, decimal, scientific notation,
  // and JS numeric separators in the existing default.
  const rx = singleLineRegex(key, `-?[\\d_]+(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?`);
  if (!rx.test(source)) {
    if (typeof console !== "undefined") {
      console.warn(`[snippet-template] no number match for const ${key}`);
    }
    return source;
  }
  return source.replace(rx, (_match, prefix, typeAnn, eq, semi) => {
    return `${prefix}${typeAnn ?? ""}${eq}${formatNumber(value)}${semi}`;
  });
}

function formatNumber(n: number): string {
  if (Number.isFinite(n) && Math.floor(n) === n) return n.toString();
  return n.toString();
}

function replaceArray(
  source: string,
  key: string,
  param: ArrayParam,
  rows: Record<string, unknown>[],
): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Multi-line block: from a `const KEY[: type]? = [` line through the matching
  // closing `];` (on its own line, possibly indented). Non-greedy `[\s\S]*?`
  // ensures we stop at the first such closing line.
  const rx = new RegExp(
    `^(\\s*const ${escapedKey})(\\s*:\\s*[^=]+?)?(\\s*=\\s*\\[)[\\s\\S]*?^(\\s*)(\\]\\s*;)\\s*$`,
    "m",
  );
  if (!rx.test(source)) {
    if (typeof console !== "undefined") {
      console.warn(`[snippet-template] no array match for const ${key}`);
    }
    return source;
  }

  const itemKeys = Object.keys(param.itemSchema);
  const isPrimitiveValue = itemKeys.length === 1 && itemKeys[0] === "value";

  return source.replace(rx, (_match, prefix, typeAnn, openEq, closeIndent, closeBracket) => {
    const indent = (openEq.match(/^\s*/) ?? [""])[0]; // not used; rows indent with 2 spaces.
    void indent;
    const inner = rows
      .map((row) => {
        if (isPrimitiveValue) {
          const raw = row.value;
          return `  ${JSON.stringify(String(raw ?? ""))},`;
        }
        const fields = itemKeys
          .map((k) => `${k}: ${JSON.stringify(String(row[k] ?? ""))}`)
          .join(", ");
        return `  { ${fields} },`;
      })
      .join("\n");
    return `${prefix}${typeAnn ?? ""}${openEq}\n${inner}\n${closeIndent}${closeBracket}`;
  });
}
