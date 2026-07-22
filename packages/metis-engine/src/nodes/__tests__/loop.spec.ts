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
import { parseLoopConfig } from '../loop.js';
import { loopBodyIds } from '../../workflows/graph.js';

describe('parseLoopConfig', () => {
  it('accepts a real array and computes iterations from batchSize', () => {
    const parsed = parseLoopConfig({ items: [1, 2, 3, 4, 5], batchSize: 2 });
    expect(parsed).toEqual({
      plan: { items: [1, 2, 3, 4, 5], batchSize: 2, maxIterations: 1000, iterations: 3 },
    });
  });

  it('accepts a JSON-string array (how substitution embeds an array ref)', () => {
    const parsed = parseLoopConfig({ items: '[{"id":1},{"id":2}]' });
    expect('plan' in parsed && parsed.plan.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect('plan' in parsed && parsed.plan.iterations).toBe(2);
  });

  it('fails clearly on non-arrays, non-JSON strings and unresolved references', () => {
    expect(parseLoopConfig({ items: 42 })).toHaveProperty('error');
    expect(parseLoopConfig({ items: 'not json' })).toHaveProperty('error');
    expect(parseLoopConfig({})).toHaveProperty('error');
    const unresolved = parseLoopConfig({ items: '{{node-x.data.rows}}' });
    expect('error' in unresolved && unresolved.error).toMatch(/did not resolve/);
  });

  it('fails BEFORE spawning when iterations exceed the cap, and clamps the cap', () => {
    const over = parseLoopConfig({ items: [1, 2, 3], batchSize: 1, maxIterations: 2 });
    expect('error' in over && over.error).toMatch(/maxIterations/);
    const clamped = parseLoopConfig({ items: [1], maxIterations: 999_999 });
    expect('plan' in clamped && clamped.plan.maxIterations).toBe(10_000);
  });
});

describe('loopBodyIds', () => {
  const edges = [
    { source: 'loop', target: 'b1', sourceHandle: 'each' },
    { source: 'b1', target: 'b2' },
    { source: 'loop', target: 'after', sourceHandle: 'done' },
    { source: 'after', target: 'tail' },
  ];
  it('collects the each-subgraph only', () => {
    expect(loopBodyIds('loop', edges).sort()).toEqual(['b1', 'b2']);
  });
});
