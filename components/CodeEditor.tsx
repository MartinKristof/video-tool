"use client";

import React from "react";
import Editor, { type BeforeMount } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import Icon from "@/components/ui/Icon";

const VHS_KEYWORDS = [
  "Output",
  "Require",
  "Set",
  "Env",
  "Sleep",
  "Wait",
  "Type",
  "Copy",
  "Paste",
  "Backspace",
  "Enter",
  "Tab",
  "Space",
  "Up",
  "Down",
  "Left",
  "Right",
  "PageUp",
  "PageDown",
  "ScrollUp",
  "ScrollDown",
  "Hide",
  "Show",
  "Source",
  "Screenshot",
  "Ctrl",
  "Alt",
  "Shift",
];

const VHS_SET_OPTIONS = [
  "Shell",
  "FontSize",
  "FontFamily",
  "Width",
  "Height",
  "Padding",
  "Margin",
  "MarginFill",
  "BorderRadius",
  "Theme",
  "TypingSpeed",
  "Framerate",
  "PlaybackSpeed",
  "LineHeight",
  "LetterSpacing",
  "LoopOffset",
  "WindowBar",
  "CursorBlink",
];

const registerVHSLanguage: BeforeMount = (monaco) => {
  if (monaco.languages.getLanguages().some((l: languages.ILanguageExtensionPoint) => l.id === "vhs")) return;

  monaco.languages.register({ id: "vhs" });

  monaco.languages.setMonarchTokensProvider("vhs", {
    keywords: VHS_KEYWORDS,
    setOptions: VHS_SET_OPTIONS,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/\b\d+(\.\d+)?(ms|s)\b/, "number"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [/(Ctrl|Alt|Shift)\+[A-Za-z]+/, "keyword.modifier"],
        [/@[\d]+(ms|s)/, "number.delay"],
        [
          /[A-Za-z]+/,
          {
            cases: {
              "@keywords": "keyword",
              "@setOptions": "type",
              "@default": "identifier",
            },
          },
        ],
      ],
    },
  });

  monaco.editor.defineTheme("vhs-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "FF64B8", fontStyle: "bold" },
      { token: "keyword.modifier", foreground: "F86606" },
      { token: "type", foreground: "20A34E" },
      { token: "string", foreground: "FEF3FF" },
      { token: "number", foreground: "246DFF" },
      { token: "number.delay", foreground: "246DFF", fontStyle: "italic" },
      { token: "comment", foreground: "5A4F60", fontStyle: "italic" },
    ],
    colors: {},
  });
};

interface CodeEditorProps {
  code: string;
  onChange: (code: string) => void;
  language?: "typescript" | "plaintext" | "vhs";
  filename?: string;
}

export default function CodeEditor({
  code,
  onChange,
  language = "typescript",
  filename,
}: CodeEditorProps) {
  const tabName = filename ?? (language === "plaintext" ? "tape.tape" : "Scene.tsx");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Tabs */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 36,
          padding: "0 6px",
          gap: 2,
          borderBottom: "0.5px solid var(--line-1)",
          background: "var(--bg-2)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 28,
            padding: "0 10px",
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--text-0)",
            background: "var(--bg-3)",
            borderRadius: 4,
          }}
        >
          <span
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: "var(--accent)",
            }}
          />
          {tabName}
        </div>
        <div style={{ flex: 1 }} />
        <Icon name="code" size={13} style={{ color: "var(--text-2)", marginRight: 6 }} />
      </div>

      {/* Editor */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language={language}
          theme={language === "vhs" ? "vhs-dark" : "vs-dark"}
          beforeMount={registerVHSLanguage}
          value={code}
          onChange={(val) => onChange(val || "")}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            tabSize: 2,
            automaticLayout: true,
            padding: { top: 8 },
          }}
        />
      </div>

      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 10px",
          height: 22,
          borderTop: "0.5px solid var(--line-1)",
          background: "var(--bg-2)",
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--text-2)",
        }}
      >
        <span>{language === "vhs" ? "VHS" : language === "plaintext" ? "TXT" : "TSX"}</span>
        <span>UTF-8</span>
        <span>LF</span>
      </div>
    </div>
  );
}
