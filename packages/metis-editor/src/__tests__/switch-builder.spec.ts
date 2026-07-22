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
  branchesToOptions,
  checkValueOf,
  modeOf,
  nextBranchId,
  seedBranches,
  type Branch,
} from '../builder/inspector/switch-builder-config.js';

describe('nextBranchId (stable branch ids that back the source-<id> handle)', () => {
  it('starts at branch-1 and increments past the highest existing id', () => {
    expect(nextBranchId([])).toBe('branch-1');
    expect(nextBranchId([{ id: 'branch-1' }, { id: 'branch-2' }])).toBe('branch-3');
  });
  it('does not reuse an id after a middle branch is deleted', () => {
    expect(nextBranchId([{ id: 'branch-1' }, { id: 'branch-3' }])).toBe('branch-4');
  });
  it('ignores ids not in the branch-N shape', () => {
    expect(nextBranchId([{ id: 'legacy' }, { id: undefined }])).toBe('branch-1');
  });
});

describe('operator value modes (match the engine checkValue shapes)', () => {
  it('maps each operator family to its input mode', () => {
    expect(modeOf('===')).toBe('single');
    expect(modeOf('isBetween')).toBe('between');
    expect(modeOf('isIn')).toBe('list');
    expect(modeOf('isNotIn')).toBe('list');
    expect(modeOf('isNull')).toBe('none');
    expect(modeOf('isTrue')).toBe('none');
  });
});

describe('checkValueOf (editor strings -> engine checkValue shape)', () => {
  const cond = (checkOperator: string, value: string, value2 = '') => ({ property: 'x', checkOperator, value, value2 });
  it('single -> the raw string', () => {
    expect(checkValueOf(cond('>', '100'))).toBe('100');
  });
  it('list -> a trimmed, non-empty string array', () => {
    expect(checkValueOf(cond('isIn', 'paid, refunded , '))).toEqual(['paid', 'refunded']);
  });
  it('between -> a [from,to] pair', () => {
    expect(checkValueOf(cond('isBetween', '10', '20'))).toEqual(['10', '20']);
  });
  it('unary -> undefined (no value sent)', () => {
    expect(checkValueOf(cond('isNull', ''))).toBeUndefined();
  });
});

describe('branchesToOptions + seedBranches round-trip', () => {
  const branches: Branch[] = [
    {
      id: 'branch-1',
      name: 'Big order',
      alias: 'big',
      conditions: [
        { property: '{{a.data.row.amount}}', checkOperator: '>', value: '100', value2: '' },
        { property: '{{a.data.row.status}}', checkOperator: 'isIn', value: 'paid, refunded', value2: '' },
      ],
    },
  ];

  it('emits switchOptions with per-operator value shapes and drops empty conditions', () => {
    const options = branchesToOptions([
      ...branches,
      { id: 'branch-2', name: 'Range', alias: '', conditions: [{ property: 'x', checkOperator: 'isBetween', value: '5', value2: '9' }, { property: '', checkOperator: '===', value: 'skip', value2: '' }] },
    ]);
    expect(options[0]).toMatchObject({
      id: 'branch-1',
      name: 'Big order',
      alias: 'big',
      conditions: [
        { property: '{{a.data.row.amount}}', checkOperator: '>', checkValue: '100' },
        { property: '{{a.data.row.status}}', checkOperator: 'isIn', checkValue: ['paid', 'refunded'] },
      ],
    });
    expect(options[1]).toMatchObject({ conditions: [{ checkOperator: 'isBetween', checkValue: ['5', '9'] }] });
    // The empty-property condition was dropped.
    expect(options[1].conditions as unknown[]).toHaveLength(1);
  });

  it('seeds the editor back from a stored config (arrays -> strings)', () => {
    const seeded = seedBranches({ switchOptions: branchesToOptions(branches) });
    expect(seeded[0].name).toBe('Big order');
    expect(seeded[0].alias).toBe('big');
    expect(seeded[0].conditions[1]).toMatchObject({ checkOperator: 'isIn', value: 'paid, refunded' });
  });
});
