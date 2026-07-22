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
 * "From a sample request": on a trigger node, paste an example body and its
 * keys become the step's declared outputs so downstream steps can reference
 * them in the variable picker. A webhook nests its body (`data.body.<key>`),
 * so its keys are prefixed; an api workflow seeds the body directly.
 */
import { useMemo, useState } from 'react';
import type { WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import { inferSampleOutputs, outputsFromRows } from './sample-outputs.js';

/** Trigger types whose runtime payload comes from the request body. */
const SAMPLEABLE = new Set(['webhookconfig', 'apiconfig']);

export function isSampleable(nodeType: string): boolean {
  return SAMPLEABLE.has(nodeType.toLowerCase());
}

/** Existing declared-output keys, read back so a reopen shows what was applied. */
function declaredKeys(node: WorkflowNode): string[] {
  const outputs = node.data?.outputs;
  if (!Array.isArray(outputs)) return [];
  const keys: string[] = [];
  for (const spec of outputs) {
    const rows = (spec as { manualData?: { key?: string }[] })?.manualData;
    for (const row of rows ?? []) if (row?.key) keys.push(row.key);
  }
  return keys;
}

export function SampleRequest({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const prefix = node.type.toLowerCase() === 'webhookconfig' ? 'body.' : '';
  const [sample, setSample] = useState('');
  const applied = useMemo(() => declaredKeys(node), [node]);
  const { rows, error } = inferSampleOutputs(sample, prefix);
  const errId = error ? 'sample-req-err' : undefined;

  const apply = () => {
    flow.updateOutputs(node.id, outputsFromRows(rows));
    setSample('');
  };
  const clear = () => flow.updateOutputs(node.id, []);

  return (
    <div className="sample-req" data-testid="sample-request">
      <p className="io-hint">
        Paste an example request. Its fields become variables the next steps can use.
      </p>
      <div className="field">
        <label htmlFor="sample-req-input">Example body (JSON)</label>
        <textarea
          id="sample-req-input"
          className="mono"
          rows={4}
          value={sample}
          placeholder={'{\n  "firstName": "Ada",\n  "email": "ada@example.com"\n}'}
          aria-invalid={error ? true : undefined}
          aria-describedby={errId}
          onChange={(event) => setSample(event.target.value)}
        />
        {error && (
          <div className="field-error" id={errId} role="alert">
            {error}
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="sample-preview" aria-label="Detected fields">
          {rows.map((row) => (
            <li key={row.key}>
              <span className="ref-name">{row.key}</span>
              <span className="ref-type">{row.type}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="sample-actions">
        <button type="button" className="btn-ghost" disabled={rows.length === 0} onClick={apply}>
          Use these fields
        </button>
        {applied.length > 0 && (
          <button type="button" className="btn-ghost" onClick={clear}>
            Clear {applied.length}
          </button>
        )}
      </div>
      {applied.length > 0 && (
        <p className="io-hint" data-testid="sample-applied">
          Declared: {applied.join(', ')}
        </p>
      )}
    </div>
  );
}
