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
 * The filter node's condition editor: one row per condition ("status equals
 * paid"), every row must hold for an element to be Kept. Same operator
 * vocabulary and adaptive value inputs as the switch editor; `field` is a
 * dot-path INTO each element (not a {{...}} reference - the items reference
 * lives in the Items field above).
 */
import { useEffect, useState } from 'react';
import type { WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import { checkValueOf, modeOf, OPERATORS, type Condition } from './switch-builder-config.js';
import { ValueInput } from './SwitchBuilder.js';

function seedRows(config: Record<string, unknown>): Condition[] {
  const raw = Array.isArray(config.conditions) ? (config.conditions as Record<string, unknown>[]) : [];
  return raw.map((row) => {
    const checkOperator = String(row?.checkOperator ?? '===');
    const mode = modeOf(checkOperator);
    const checkValue = row?.checkValue;
    if (mode === 'between' && Array.isArray(checkValue)) {
      return { property: String(row?.field ?? ''), checkOperator, value: String(checkValue[0] ?? ''), value2: String(checkValue[1] ?? '') };
    }
    if (mode === 'list' && Array.isArray(checkValue)) {
      return { property: String(row?.field ?? ''), checkOperator, value: checkValue.join(', '), value2: '' };
    }
    return {
      property: String(row?.field ?? ''),
      checkOperator,
      value: checkValue === undefined || checkValue === null ? '' : String(checkValue),
      value2: '',
    };
  });
}

const blank = (): Condition => ({ property: '', checkOperator: '===', value: '', value2: '' });

export function FilterBuilder({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const [rows, setRows] = useState<Condition[]>(() =>
    seedRows((node.data?.config ?? {}) as Record<string, unknown>),
  );
  useEffect(() => setRows(seedRows((node.data?.config ?? {}) as Record<string, unknown>)), [node.id]);

  const commit = (next: Condition[]) => {
    setRows(next);
    const conditions = next
      .filter((row) => row.property.trim() !== '')
      .map((row) => {
        const checkValue = checkValueOf(row);
        return {
          field: row.property.trim(),
          checkOperator: row.checkOperator,
          ...(checkValue === undefined ? {} : { checkValue }),
        };
      });
    flow.updateConfigField(node.id, 'conditions', conditions.length > 0 ? conditions : undefined);
  };
  const patch = (index: number, change: Partial<Condition>) =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  return (
    <div className="switch-conds filter-builder" data-field="filterBuilder">
      {rows.map((row, index) => (
        <div className="switch-cond" key={index}>
          <span className="switch-when">{index === 0 ? 'Keep' : 'and'}</span>
          <input
            className="logic-field mono"
            type="text"
            value={row.property}
            placeholder="field, e.g. status"
            aria-label="Element field"
            onChange={(event) => patch(index, { property: event.target.value })}
          />
          <select
            className="kv-op"
            value={row.checkOperator}
            aria-label="Operator"
            onChange={(event) => patch(index, { checkOperator: event.target.value })}
          >
            {OPERATORS.map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </select>
          <ValueInput condition={row} onPatch={(change) => patch(index, change)} />
          <button
            type="button"
            className="btn btn-sm kv-remove"
            aria-label="Remove condition"
            onClick={() => commit(rows.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => commit([...rows, blank()])}>
        Add condition
      </button>
      <p className="help">
        Elements passing every condition go to <strong>Kept</strong>; the rest to <strong>Discarded</strong>.
        An empty side&apos;s branch does not run.
      </p>
    </div>
  );
}
