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
 * The logic node's rule engine: the predicate tree evaluator and the branch it
 * decides. Pure, so it is tested directly without the workflow.
 */
import { describe, it, expect } from 'vitest';
import { evaluateLeaf, evaluatePredicate, logicBranch } from '../nodes/logic.js';

describe('logic predicate engine', () => {
  it('evaluates leaf operators against a dot-path input', () => {
    const input = { user: { tier: 'gold', age: 40, tags: ['vip'] }, name: '' };
    expect(evaluateLeaf({ lhs: 'input.user.tier', op: 'eq', rhs: 'gold' }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.age', op: 'gte', rhs: 18 }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.age', op: 'lt', rhs: 18 }, input)).toBe(false);
    expect(evaluateLeaf({ lhs: 'user.tags', op: 'contains', rhs: 'vip' }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.tier', op: 'startsWith', rhs: 'go' }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.tier', op: 'exists' }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.missing', op: 'exists' }, input)).toBe(false);
    expect(evaluateLeaf({ lhs: 'name', op: 'isEmpty' }, input)).toBe(true);
  });

  it('evaluates the remaining leaf operators (neq, lte, endsWith)', () => {
    const input = { user: { tier: 'gold', age: 40 } };
    expect(evaluateLeaf({ lhs: 'user.tier', op: 'neq', rhs: 'silver' }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.tier', op: 'neq', rhs: 'gold' }, input)).toBe(false);
    expect(evaluateLeaf({ lhs: 'user.age', op: 'lte', rhs: 40 }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.age', op: 'lte', rhs: 18 }, input)).toBe(false);
    expect(evaluateLeaf({ lhs: 'user.tier', op: 'endsWith', rhs: 'ld' }, input)).toBe(true);
    expect(evaluateLeaf({ lhs: 'user.tier', op: 'endsWith', rhs: 'go' }, input)).toBe(false);
  });

  it('treats a missing left-hand path as falsy, never a throw', () => {
    expect(evaluateLeaf({ lhs: 'a.b.c.d', op: 'eq', rhs: 1 }, {})).toBe(false);
  });

  it('combines AND / OR / NOT recursively', () => {
    const input = { tier: 'gold', amount: 150 };
    const tree = {
      op: 'AND' as const,
      children: [
        { leaf: { lhs: 'tier', op: 'eq' as const, rhs: 'gold' } },
        {
          op: 'OR' as const,
          children: [
            { leaf: { lhs: 'amount', op: 'gt' as const, rhs: 1000 } },
            { leaf: { lhs: 'amount', op: 'gte' as const, rhs: 100 } },
          ],
        },
      ],
    };
    expect(evaluatePredicate(tree, input)).toBe(true);
    expect(evaluatePredicate({ op: 'NOT', children: [tree] }, input)).toBe(false);
  });

  it('guards vacuous truth: AND/OR with no children is false', () => {
    expect(evaluatePredicate({ op: 'AND', children: [] }, {})).toBe(false);
    expect(evaluatePredicate({ op: 'OR', children: [] }, {})).toBe(false);
    expect(evaluatePredicate(undefined, {})).toBe(false);
  });

  it('logicBranch returns the taken branch as "true" / "false"', () => {
    const predicate = { leaf: { lhs: 'ok', op: 'eq' as const, rhs: true } };
    expect(logicBranch({ predicate }, { ok: true })).toBe('true');
    expect(logicBranch({ predicate }, { ok: false })).toBe('false');
  });
});
