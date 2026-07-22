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
 * Pure logic for the logic node's predicate-tree editor (parity with the Helix
 * logic inspector). Works directly in the engine's predicate shape
 * ({op:AND/OR/NOT, children[]} groups; {leaf:{lhs,op,rhs}} leaves). The editor
 * holds rhs as a string; committing coerces a numeric string to a number so the
 * numeric operators (gt/gte/lt/lte, which require both operands numeric) work,
 * and seeding turns it back into a string for the input.
 */

export type GroupOp = 'AND' | 'OR' | 'NOT';

export interface LeafPredicate {
  lhs: string;
  op: string;
  rhs?: string | number | boolean | null;
}
export interface PredicateNode {
  op?: GroupOp;
  children?: PredicateNode[];
  leaf?: LeafPredicate;
}

/** The logic engine's 11 leaf operators (nodes/logic.ts), with Helix labels. */
export const LEAF_OPERATORS: { value: string; label: string }[] = [
  { value: 'eq', label: '= equals' },
  { value: 'neq', label: '≠ not equals' },
  { value: 'gt', label: '> greater than' },
  { value: 'gte', label: '≥ greater or equal' },
  { value: 'lt', label: '< less than' },
  { value: 'lte', label: '≤ less or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'exists', label: 'exists' },
  { value: 'isEmpty', label: 'is empty' },
];
/** Unary operators: no right-hand value. */
export const LEAF_NOVALUE = new Set(['exists', 'isEmpty']);

export const GROUP_OPS: GroupOp[] = ['AND', 'OR', 'NOT'];

export const isLeaf = (node: PredicateNode | undefined): boolean => node?.leaf !== undefined;
export const blankLeaf = (): PredicateNode => ({ leaf: { lhs: '', op: 'eq', rhs: '' } });
export const blankGroup = (op: GroupOp = 'AND'): PredicateNode => ({ op, children: [blankLeaf()] });

/** A numeric string becomes a number (so gt/gte/lt/lte compare numerically);
 *  everything else stays a string. */
export function coerceRhs(value: unknown): string | number {
  const text = value === undefined || value === null ? '' : String(value);
  return /^-?\d+(\.\d+)?$/.test(text.trim()) && text.trim() !== '' ? Number(text) : text;
}

/** Deep-map every leaf in a predicate tree, returning a new tree. */
function mapLeaves(node: PredicateNode, fn: (leaf: LeafPredicate) => LeafPredicate): PredicateNode {
  if (node.leaf) return { ...node, leaf: fn(node.leaf) };
  return { ...node, children: (node.children ?? []).map((child) => mapLeaves(child, fn)) };
}

/** The config.predicate the engine runs, from the editor tree (rhs coerced). */
export function predicateToConfig(tree: PredicateNode): PredicateNode {
  return mapLeaves(tree, (leaf) => ({
    lhs: leaf.lhs,
    op: leaf.op,
    ...(LEAF_NOVALUE.has(leaf.op) ? {} : { rhs: coerceRhs(leaf.rhs) }),
  }));
}

/** The editor tree from a stored config: a valid predicate, else a default AND
 *  group with one empty leaf; every rhs as a string for the input. */
export function seedPredicate(config: Record<string, unknown>): PredicateNode {
  const predicate = config?.predicate as PredicateNode | undefined;
  const valid =
    predicate && typeof predicate === 'object' && (isLeaf(predicate) || Array.isArray(predicate.children));
  const tree = valid ? predicate : blankGroup('AND');
  return mapLeaves(tree, (leaf) => ({
    lhs: String(leaf.lhs ?? ''),
    op: String(leaf.op ?? 'eq'),
    rhs: leaf.rhs === undefined || leaf.rhs === null ? '' : String(leaf.rhs),
  }));
}
