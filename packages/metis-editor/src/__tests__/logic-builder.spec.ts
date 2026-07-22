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
import { describe, it, expect } from 'vitest';
import {
  coerceRhs,
  isLeaf,
  predicateToConfig,
  seedPredicate,
  type PredicateNode,
} from '../builder/inspector/logic-builder-config.js';

describe('coerceRhs (numeric operators need numeric rhs)', () => {
  it('turns a numeric string into a number, keeps other strings', () => {
    expect(coerceRhs('100')).toBe(100);
    expect(coerceRhs('-3.5')).toBe(-3.5);
    expect(coerceRhs('paid')).toBe('paid');
    expect(coerceRhs('')).toBe('');
  });
});

describe('seedPredicate', () => {
  it('defaults an empty/invalid config to an AND group with one leaf', () => {
    const tree = seedPredicate({});
    expect(tree.op).toBe('AND');
    expect(tree.children).toHaveLength(1);
    expect(isLeaf(tree.children![0])).toBe(true);
  });
  it('keeps a valid tree and stringifies rhs for the inputs', () => {
    const tree = seedPredicate({
      predicate: { op: 'OR', children: [{ leaf: { lhs: 'input.amount', op: 'gt', rhs: 100 } }] },
    });
    expect(tree.op).toBe('OR');
    expect(tree.children![0].leaf).toEqual({ lhs: 'input.amount', op: 'gt', rhs: '100' });
  });
});

describe('predicateToConfig (editor tree -> engine predicate)', () => {
  it('coerces numeric rhs and drops rhs for unary ops, recursively', () => {
    const tree: PredicateNode = {
      op: 'AND',
      children: [
        { leaf: { lhs: 'input.amount', op: 'gt', rhs: '100' } },
        { op: 'OR', children: [{ leaf: { lhs: 'input.email', op: 'exists', rhs: '' } }] },
      ],
    };
    const config = predicateToConfig(tree);
    expect(config.children![0].leaf).toEqual({ lhs: 'input.amount', op: 'gt', rhs: 100 });
    // Unary op: no rhs key at all.
    expect(config.children![1].children![0].leaf).toEqual({ lhs: 'input.email', op: 'exists' });
  });

  it('round-trips through seed', () => {
    const seeded = seedPredicate({ predicate: predicateToConfig({ op: 'AND', children: [{ leaf: { lhs: 'x', op: 'gte', rhs: '5' } }] }) });
    expect(seeded.children![0].leaf).toEqual({ lhs: 'x', op: 'gte', rhs: '5' });
  });
});
