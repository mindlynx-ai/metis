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
 * The logic node's rule engine (parity with the Helix logic node): a recursive
 * predicate tree (AND / OR / NOT with leaf conditions) evaluated against the
 * run input, deciding a 'true' / 'false' branch. Pure and side-effect-free so
 * the workflow stays deterministic; a missing left-hand path is falsy, never a
 * throw, so a partial payload never crashes the run.
 */

export type LeafOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'exists'
  | 'isEmpty';

export interface LeafPredicate {
  lhs: string;
  op: LeafOp;
  rhs?: string | number | boolean | null;
}

export interface PredicateNode {
  op?: 'AND' | 'OR' | 'NOT';
  children?: PredicateNode[];
  leaf?: LeafPredicate;
}

export interface LogicConfig {
  predicate?: PredicateNode;
}

/** Resolve a `ctx.input.`/`input.`-prefixed dot path against the input map. */
function resolveLhs(lhs: string, input: Record<string, unknown>): unknown {
  let key = lhs;
  if (key.startsWith('ctx.input.')) key = key.slice('ctx.input.'.length);
  else if (key.startsWith('input.')) key = key.slice('input.'.length);
  let cursor: unknown = input;
  for (const part of key.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

const num = (v: unknown, r: unknown, f: (a: number, b: number) => boolean): boolean =>
  typeof v === 'number' && typeof r === 'number' && f(v, r);
const str = (v: unknown, r: unknown, f: (a: string, b: string) => boolean): boolean =>
  typeof v === 'string' && typeof r === 'string' && f(v, r);

/** One evaluator per leaf operator; keeps evaluateLeaf a flat table lookup. */
const LEAF_OPS: Record<LeafOp, (value: unknown, rhs: unknown) => boolean> = {
  exists: (v) => v !== undefined && v !== null,
  isEmpty: (v) => {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
    return false;
  },
  // Intentional loose (in)equality for cross-type leaf comparison.
  eq: (v, r) => v == r,
  neq: (v, r) => v != r,
  gt: (v, r) => num(v, r, (a, b) => a > b),
  gte: (v, r) => num(v, r, (a, b) => a >= b),
  lt: (v, r) => num(v, r, (a, b) => a < b),
  lte: (v, r) => num(v, r, (a, b) => a <= b),
  contains: (v, r) => {
    if (str(v, r, (a, b) => a.includes(b))) return true;
    return Array.isArray(v) && v.includes(r);
  },
  startsWith: (v, r) => str(v, r, (a, b) => a.startsWith(b)),
  endsWith: (v, r) => str(v, r, (a, b) => a.endsWith(b)),
};

export function evaluateLeaf(leaf: LeafPredicate, input: Record<string, unknown>): boolean {
  const evaluator = LEAF_OPS[leaf.op];
  return evaluator ? evaluator(resolveLhs(leaf.lhs, input), leaf.rhs) : false;
}

/**
 * Evaluate a predicate tree. A node with a `leaf` evaluates it directly; else
 * the `op` combines its children. AND with no children is false (guards
 * vacuous truth), OR with no children is false, NOT negates its first child.
 */
export function evaluatePredicate(
  node: PredicateNode | undefined,
  input: Record<string, unknown>,
): boolean {
  if (!node) return false;
  if (node.leaf) return node.leaf.lhs ? evaluateLeaf(node.leaf, input) : false;

  const children = node.children ?? [];
  if (node.op === 'AND') return children.length > 0 && children.every((c) => evaluatePredicate(c, input));
  if (node.op === 'OR') return children.some((c) => evaluatePredicate(c, input));
  if (node.op === 'NOT') return children.length > 0 && !evaluatePredicate(children[0], input);
  return false;
}

/** Evaluate the logic node's predicate to its taken branch. */
export function logicBranch(config: LogicConfig, input: Record<string, unknown>): 'true' | 'false' {
  return evaluatePredicate(config.predicate, input) ? 'true' : 'false';
}
