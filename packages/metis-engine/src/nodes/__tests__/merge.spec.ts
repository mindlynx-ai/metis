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
import { mergeSources } from '../merge.js';
import type { NodeStateEntry } from '../../types.js';

const states: NodeStateEntry[] = [
  { nodeId: 'a', stateId: '1', stateData: { status: 200, data: { from: 'a-old' } } },
  { nodeId: 'a', stateId: '2', stateData: { status: 200, data: { from: 'a', x: 1 } } },
  { nodeId: 'b', stateId: '3', stateData: { status: 200, data: { from: 'b', y: 2 } } },
];
const live = (id: string) => ({ id, orphaned: false });

describe('mergeSources', () => {
  it('append: the LATEST state entry per source, in source order', () => {
    expect(mergeSources([live('a'), live('b')], states, 'append')).toEqual({
      items: [{ from: 'a', x: 1 }, { from: 'b', y: 2 }],
      count: 2,
    });
  });

  it('combine: shallow merge, later sources winning; pick: first live data', () => {
    expect(mergeSources([live('a'), live('b')], states, 'combine')).toEqual({ from: 'b', x: 1, y: 2 });
    expect(mergeSources([live('a'), live('b')], states, 'pick')).toEqual({ from: 'a', x: 1 });
  });

  it('excludes orphaned sources and tolerates missing state', () => {
    expect(mergeSources([{ id: 'a', orphaned: true }, live('b'), live('ghost')], states, 'append')).toEqual({
      items: [{ from: 'b', y: 2 }],
      count: 1,
    });
    expect(mergeSources([{ id: 'a', orphaned: true }], states, 'pick')).toEqual({});
  });
});
