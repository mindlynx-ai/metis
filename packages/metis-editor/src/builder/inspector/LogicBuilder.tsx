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
 * The logic node's predicate-tree editor (parity with the Helix logic
 * inspector): a recursive AND / OR / NOT builder. A group combines its children
 * with the chosen operator; a leaf is one "value operator value" condition. Add
 * a condition (leaf) or a nested group at any level. The logic node routes
 * true/false on the canvas. The "value to check" field is plain text, so the
 * variable picker inserts a reference into it.
 */
import { useEffect, useState } from 'react';
import type { WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import {
  blankGroup,
  blankLeaf,
  GROUP_OPS,
  isLeaf,
  LEAF_NOVALUE,
  LEAF_OPERATORS,
  predicateToConfig,
  seedPredicate,
  type LeafPredicate,
  type PredicateNode,
} from './logic-builder-config.js';

function LeafView({
  node,
  onChange,
  onRemove,
}: {
  node: PredicateNode;
  onChange: (node: PredicateNode) => void;
  onRemove: () => void;
}) {
  const leaf = node.leaf as LeafPredicate;
  const setLeaf = (patch: Partial<LeafPredicate>) => onChange({ leaf: { ...leaf, ...patch } });
  return (
    <div className="pred-leaf">
      <input
        className="logic-field mono"
        type="text"
        value={leaf.lhs}
        placeholder="ctx.input.amount"
        aria-label="Field to check"
        onChange={(event) => setLeaf({ lhs: event.target.value })}
      />
      <select
        className="kv-op"
        value={leaf.op}
        aria-label="Operator"
        onChange={(event) => setLeaf({ op: event.target.value })}
      >
        {LEAF_OPERATORS.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </select>
      {LEAF_NOVALUE.has(leaf.op) ? (
        <span className="switch-novalue">(no value)</span>
      ) : (
        <input
          className="switch-val"
          value={String(leaf.rhs ?? '')}
          placeholder="value"
          aria-label="Compared to"
          onChange={(event) => setLeaf({ rhs: event.target.value })}
        />
      )}
      <button type="button" className="btn btn-sm kv-remove" aria-label="Remove condition" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function GroupView({
  node,
  onChange,
  onRemove,
  depth,
}: {
  node: PredicateNode;
  onChange: (node: PredicateNode) => void;
  onRemove?: () => void;
  depth: number;
}) {
  const children = node.children ?? [];
  const withChildren = (next: PredicateNode[]) => onChange({ ...node, children: next });
  const patchChild = (index: number, child: PredicateNode) =>
    withChildren(children.map((current, i) => (i === index ? child : current)));
  const removeChild = (index: number) => withChildren(children.filter((_, i) => i !== index));

  return (
    <div className={`pred-group depth-${Math.min(depth, 4)}`} role="group">
      <div className="pred-group-head">
        <div className="seg" role="tablist" aria-label="Combine conditions">
          {GROUP_OPS.map((op) => (
            <button
              key={op}
              type="button"
              role="tab"
              aria-selected={node.op === op}
              className={`seg-btn${node.op === op ? ' active' : ''}`}
              onClick={() => onChange({ ...node, op })}
            >
              {op}
            </button>
          ))}
        </div>
        <div className="pred-group-actions">
          <button type="button" className="btn btn-sm" onClick={() => withChildren([...children, blankLeaf()])}>
            Add condition
          </button>
          <button type="button" className="btn btn-sm" onClick={() => withChildren([...children, blankGroup()])}>
            Add group
          </button>
          {onRemove && (
            <button type="button" className="btn btn-sm kv-remove" aria-label="Remove group" onClick={onRemove}>
              ×
            </button>
          )}
        </div>
      </div>
      <div className="pred-children">
        {children.map((child, index) =>
          isLeaf(child) ? (
            <LeafView
              key={index}
              node={child}
              onChange={(next) => patchChild(index, next)}
              onRemove={() => removeChild(index)}
            />
          ) : (
            <GroupView
              key={index}
              node={child}
              depth={depth + 1}
              onChange={(next) => patchChild(index, next)}
              onRemove={() => removeChild(index)}
            />
          ),
        )}
        {children.length === 0 && <p className="help">Add a condition or a group.</p>}
      </div>
    </div>
  );
}

export function LogicBuilder({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const [tree, setTree] = useState<PredicateNode>(() =>
    seedPredicate((node.data?.config ?? {}) as Record<string, unknown>),
  );
  useEffect(
    () => setTree(seedPredicate((node.data?.config ?? {}) as Record<string, unknown>)),
    [node.id],
  );

  const commit = (next: PredicateNode) => {
    setTree(next);
    flow.updateConfigField(node.id, 'predicate', predicateToConfig(next));
  };

  return (
    <div className="logic-builder" data-field="logicBuilder">
      <GroupView node={tree} onChange={commit} depth={0} />
      <p className="help">
        The rule tests the workflow&apos;s input (its trigger data); reference a field as
        <span className="mono"> ctx.input.&lt;name&gt;</span>. The <strong>Yes</strong> branch runs when it
        holds, otherwise <strong>No</strong>. (To branch on an earlier step&apos;s output, use a Switch.)
      </p>
    </div>
  );
}
