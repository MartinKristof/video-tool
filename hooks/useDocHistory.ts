"use client";

import { useCallback, useRef } from "react";
import type { EditorDoc } from "@/lib/editor-doc";

const MAX_HISTORY = 100;

export interface DocHistoryControls {
  pushSnapshot: (doc: EditorDoc) => void;
  undo: () => EditorDoc | null;
  redo: () => EditorDoc | null;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Undo/redo for the editor document. Same shape as useCodeHistory, and the same
 * invariant it exists to protect: the CURRENT state stays at the top of the
 * stack, so one Cmd+Z steps back exactly one edit. (The earlier bug was callers
 * pushing only the pre-edit state, which left the first edit with nothing to
 * undo to and made later undos jump a step too far.)
 *
 * Documents are plain data, so a snapshot is the document itself — no
 * serialisation, and every edit already returns a new object.
 */
export function useDocHistory(): DocHistoryControls {
  const historyRef = useRef<EditorDoc[]>([]);
  const indexRef = useRef(-1);

  const pushSnapshot = useCallback((doc: EditorDoc) => {
    const history = historyRef.current;
    const idx = indexRef.current;
    if (idx >= 0 && history[idx] === doc) return;

    historyRef.current = history.slice(0, idx + 1);
    historyRef.current.push(doc);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current = historyRef.current.slice(-MAX_HISTORY);
    }
    indexRef.current = historyRef.current.length - 1;
  }, []);

  const undo = useCallback((): EditorDoc | null => {
    if (indexRef.current <= 0) return null;
    indexRef.current--;
    return historyRef.current[indexRef.current];
  }, []);

  const redo = useCallback((): EditorDoc | null => {
    if (indexRef.current >= historyRef.current.length - 1) return null;
    indexRef.current++;
    return historyRef.current[indexRef.current];
  }, []);

  return {
    pushSnapshot,
    undo,
    redo,
    get canUndo() {
      return indexRef.current > 0;
    },
    get canRedo() {
      return indexRef.current < historyRef.current.length - 1;
    },
  };
}
