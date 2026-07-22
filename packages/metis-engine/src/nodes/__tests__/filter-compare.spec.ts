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
import { filterItems } from '../filter.js';
import { compareDatasets } from '../compare.js';

const orders = [
  { id: 1, status: 'paid', amount: 120 },
  { id: 2, status: 'pending', amount: 80 },
  { id: 3, status: 'paid', amount: 30 },
];

describe('filterItems', () => {
  it('partitions by the AND of conditions (switch operator vocabulary)', () => {
    const { kept, discarded } = filterItems(orders, [
      { field: 'status', checkOperator: '===', checkValue: 'paid' },
      { field: 'amount', checkOperator: '>', checkValue: '100' },
    ]);
    expect(kept.map((order) => (order as { id: number }).id)).toEqual([1]);
    expect(discarded).toHaveLength(2);
  });

  it('nested dot-paths, unary operators, and no conditions keep everything', () => {
    const nested = [{ meta: { vip: true } }, { meta: { vip: false } }];
    expect(filterItems(nested, [{ field: 'meta.vip', checkOperator: 'isTrue' }]).kept).toHaveLength(1);
    expect(filterItems(orders, []).kept).toHaveLength(3);
  });
});

describe('compareDatasets', () => {
  const a = [
    { email: 'ada@x.com', tier: 'gold' },
    { email: 'alan@x.com', tier: 'standard' },
    { email: 'grace@x.com', tier: 'gold' },
  ];
  const b = [
    { email: 'ada@x.com', tier: 'gold' },
    { email: 'alan@x.com', tier: 'gold' },
    { email: 'mh@x.com', tier: 'gold' },
  ];

  it('routes to aOnly / same / different / bOnly keyed by matchFields', () => {
    const result = compareDatasets(a, b, ['email']);
    expect(result.same.map((element) => (element as { email: string }).email)).toEqual(['ada@x.com']);
    expect(result.different).toHaveLength(1);
    expect((result.different[0]!.a as { email: string }).email).toBe('alan@x.com');
    expect(result.aOnly.map((element) => (element as { email: string }).email)).toEqual(['grace@x.com']);
    expect(result.bOnly.map((element) => (element as { email: string }).email)).toEqual(['mh@x.com']);
  });

  it('same-ness ignores key order (canonical serialisation)', () => {
    const result = compareDatasets([{ k: 1, x: 1, y: 2 }], [{ y: 2, x: 1, k: 1 }], ['k']);
    expect(result.same).toHaveLength(1);
    expect(result.different).toHaveLength(0);
  });
});
