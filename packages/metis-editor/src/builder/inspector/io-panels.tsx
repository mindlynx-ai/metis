/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The "Passes on" region, in plain English for a non-technical reader: the
 * fields this step hands downstream, each a `{{node-<id>.data.<field>}}`
 * reference chip you can click to copy. Fields come from this step's own
 * outputSchema plus any manual outputs it declares from a sample. (Upstream
 * "What it receives" is the insert-capable VariablePalette, not here.)
 */
import { useState } from 'react';
import type { CatalogueEntry, JsonSchema, WorkflowNode } from '../../api.js';

/** A reference token that copies itself to the clipboard when clicked. */
function RefChip({ token, label, type }: { token: string; label: string; type?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(token)?.then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <button
      type="button"
      className="ref-chip"
      title={`Copy ${token}`}
      aria-label={`Copy reference ${token}`}
      onClick={copy}
    >
      <span className="ref-name">{label}</span>
      {type && <span className="ref-type">{type}</span>}
      <span className="ref-copy" aria-hidden="true">
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

/** Field names a schema (and its manual outputs) expose, with JSON types. */
function fieldsOf(schema: JsonSchema | undefined, outputs: unknown): { name: string; type?: string }[] {
  const fields: { name: string; type?: string }[] = [];
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    fields.push({ name, type: property.type });
  }
  // Manual outputs: data.outputs is [{ manualData: [{ key, type, value }] }].
  if (Array.isArray(outputs)) {
    for (const spec of outputs) {
      const rows = (spec as { manualData?: { key: string; type: string }[] })?.manualData;
      for (const row of rows ?? []) {
        if (row?.key && !fields.some((field) => field.name === row.key)) {
          fields.push({ name: row.key, type: row.type });
        }
      }
    }
  }
  return fields;
}

export function OutputsPanel({
  node,
  entry,
}: {
  node: WorkflowNode;
  entry: CatalogueEntry | undefined;
}) {
  const fields = fieldsOf(entry?.outputSchema, node.data?.outputs);
  if (fields.length === 0) {
    return <p className="io-empty">This step passes its result straight through.</p>;
  }
  return (
    <div className="chips">
      {fields.map((field) => (
        <RefChip
          key={field.name}
          token={`{{${node.id}.data.${field.name}}}`}
          label={field.name}
          type={field.type}
        />
      ))}
    </div>
  );
}
