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
 * The switch node's branch editor (parity with the Helix switch inspector): name
 * a branch and give it one or more conditions ("when {{order.amount}} is greater
 * than 100"); all of a branch's conditions must hold (AND). Each branch backs a
 * `source-<id>` canvas handle, and a rose DEFAULT card stands for the
 * `source-default` fall-through. The value input adapts to the operator: a plain
 * value, a from/to pair for `is between`, a comma list for `is in list`, or no
 * value for the unary operators. The "value to check" field is plain text, so
 * the variable picker inserts a reference into it.
 */
import { useEffect, useState } from 'react';
import type { WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import {
  blankCondition,
  branchesToOptions,
  modeOf,
  nextBranchId,
  OPERATORS,
  seedBranches,
  type Branch,
  type Condition,
} from './switch-builder-config.js';

export function ValueInput({
  condition,
  onPatch,
}: {
  condition: Condition;
  onPatch: (patch: Partial<Condition>) => void;
}) {
  const mode = modeOf(condition.checkOperator);
  if (mode === 'none') return <span className="switch-novalue">(no value)</span>;
  if (mode === 'between') {
    return (
      <span className="switch-between">
        <input
          className="switch-val"
          value={condition.value}
          placeholder="from"
          aria-label="From"
          onChange={(event) => onPatch({ value: event.target.value })}
        />
        <span className="switch-between-sep">and</span>
        <input
          className="switch-val"
          value={condition.value2}
          placeholder="to"
          aria-label="To"
          onChange={(event) => onPatch({ value2: event.target.value })}
        />
      </span>
    );
  }
  return (
    <input
      className="switch-val"
      value={condition.value}
      placeholder={mode === 'list' ? 'paid, refunded' : 'value'}
      aria-label={mode === 'list' ? 'Values (comma separated)' : 'Compared to'}
      onChange={(event) => onPatch({ value: event.target.value })}
    />
  );
}

export function SwitchBuilder({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const [branches, setBranches] = useState<Branch[]>(() =>
    seedBranches((node.data?.config ?? {}) as Record<string, unknown>),
  );
  useEffect(
    () => setBranches(seedBranches((node.data?.config ?? {}) as Record<string, unknown>)),
    [node.id],
  );

  const commit = (next: Branch[]) => {
    setBranches(next);
    const options = branchesToOptions(next);
    flow.updateConfigField(node.id, 'switchOptions', options.length > 0 ? options : undefined);
  };

  const patchBranch = (index: number, patch: Partial<Branch>) =>
    commit(branches.map((branch, i) => (i === index ? { ...branch, ...patch } : branch)));
  const patchCondition = (bi: number, ci: number, patch: Partial<Condition>) =>
    patchBranch(bi, {
      conditions: branches[bi]!.conditions.map((condition, i) =>
        i === ci ? { ...condition, ...patch } : condition,
      ),
    });
  const addBranch = () =>
    commit([
      ...branches,
      { id: nextBranchId(branches), name: `Branch ${branches.length + 1}`, alias: '', conditions: [blankCondition()] },
    ]);
  const removeBranch = (index: number) => commit(branches.filter((_, i) => i !== index));
  const addCondition = (bi: number) =>
    patchBranch(bi, { conditions: [...branches[bi]!.conditions, blankCondition()] });
  const removeCondition = (bi: number, ci: number) =>
    patchBranch(bi, { conditions: branches[bi]!.conditions.filter((_, i) => i !== ci) });

  return (
    <div className="switch-builder" data-field="switchBuilder">
      {branches.map((branch, bi) => (
        <div className="switch-branch" key={branch.id}>
          <div className="switch-branch-head">
            <input
              className="switch-branch-name"
              value={branch.name}
              placeholder="Branch name (e.g. Big order)"
              aria-label="Branch name"
              onChange={(event) => patchBranch(bi, { name: event.target.value })}
            />
            <input
              className="switch-branch-alias"
              value={branch.alias}
              placeholder="alias"
              aria-label="Branch alias"
              onChange={(event) => patchBranch(bi, { alias: event.target.value })}
            />
            <button
              type="button"
              className="btn btn-sm kv-remove"
              aria-label="Remove branch"
              onClick={() => removeBranch(bi)}
            >
              ×
            </button>
          </div>
          <div className="switch-conds">
            {branch.conditions.map((condition, ci) => (
              <div className="switch-cond" key={ci}>
                <span className="switch-when">{ci === 0 ? 'When' : 'and'}</span>
                <input
                  className="switch-prop"
                  type="text"
                  value={condition.property}
                  placeholder="value, e.g. {{step.data.row.amount}}"
                  aria-label="Value to check"
                  onChange={(event) => patchCondition(bi, ci, { property: event.target.value })}
                />
                <select
                  className="kv-op"
                  value={condition.checkOperator}
                  aria-label="Operator"
                  onChange={(event) => patchCondition(bi, ci, { checkOperator: event.target.value })}
                >
                  {OPERATORS.map((operator) => (
                    <option key={operator.value} value={operator.value}>
                      {operator.label}
                    </option>
                  ))}
                </select>
                <ValueInput condition={condition} onPatch={(patch) => patchCondition(bi, ci, patch)} />
                <button
                  type="button"
                  className="btn btn-sm kv-remove"
                  aria-label="Remove condition"
                  onClick={() => removeCondition(bi, ci)}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => addCondition(bi)}>
              Add condition
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="btn btn-sm switch-add-branch" onClick={addBranch}>
        Add a branch
      </button>
      <div className="switch-default">
        <span className="switch-default-tag">Default</span>
        Route here when no branch matches.
      </div>
    </div>
  );
}
