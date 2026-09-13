"use client";

import React, { useState } from "react";
import Modal from "@/components/ui/Modal";
import SnippetParamsForm from "@/components/SnippetParamsForm";
import { SNIPPET_SCHEMAS, buildDefaultValues } from "@/lib/snippet-schemas";
import { renderSnippet } from "@/lib/snippet-template";
import type { SceneItem } from "@/lib/editor-doc";

/**
 * Reopen the parameter form for a snippet block that's already on the timeline,
 * so its texts can be changed without deleting and re-inserting it.
 *
 * Re-rendering runs over the block's CURRENT code rather than a fresh copy from
 * the library: the substitution is line-anchored and idempotent, so this changes
 * only the constants the form owns and leaves any other edit to the file — or
 * any drift in the library since insertion — untouched.
 *
 * `SnippetParamsForm` already supports a controlled `values` prop (NewProjectModal
 * uses it), so seeding it with the stored values needs no change there.
 */
export default function SnippetEditDialog({
  item, open, onClose, onSave,
}: {
  item: SceneItem | null;
  open: boolean;
  onClose: () => void;
  onSave: (code: string, values: Record<string, unknown>) => void;
}) {
  if (!open || !item?.snippet) return null;
  const schema = SNIPPET_SCHEMAS[item.snippet.id];
  if (!schema) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${item.snippet.id}`} width={520}>
      {/* Keyed on the block, so opening a different one starts from ITS values
          rather than carrying the previous block's state over. */}
      <SnippetEditForm key={item.id} item={item} onClose={onClose} onSave={onSave} />
    </Modal>
  );
}

function SnippetEditForm({
  item, onClose, onSave,
}: {
  item: SceneItem;
  onClose: () => void;
  onSave: (code: string, values: Record<string, unknown>) => void;
}) {
  const schema = SNIPPET_SCHEMAS[item.snippet!.id];
  // Seeded from what the block was built with, falling back to schema defaults
  // for any parameter added to the library since it was inserted.
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...buildDefaultValues(schema),
    ...item.snippet!.values,
  }));

  return (
    <SnippetParamsForm
      schema={schema}
      values={values}
      onValuesChange={setValues}
      insertLabel="Save changes"
      onInsert={(next) => {
        onSave(renderSnippet(item.code, schema, next), next);
        onClose();
      }}
    />
  );
}
