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
import { checkConditionResult, checkSwitchCondition, partitionTargets } from '../switch.js';

describe('checkConditionResult: the fifteen operators', () => {
  it.each([
    ['===', 5, '5', true],
    ['===', 'a', 'a', true],
    ['===', 'a', 'b', false],
    ['!==', 'a', 'b', true],
    ['!==', 7, '7', false],
    ['<', 3, '5', true],
    ['<', 9, '5', false],
    ['>', 9, '5', true],
    ['<=', 5, '5', true],
    ['>=', 4, '5', false],
    ['contains', 'hello world', 'world', true],
    ['contains', ['a', 'b'], 'b', true],
    ['contains', ['a', 'b'], 'z', false],
    ['isTrue', true, undefined, true],
    ['isTrue', 'true', undefined, false],
    ['isFalse', false, undefined, true],
    ['isNull', null, undefined, true],
    ['isNull', undefined, undefined, true],
    ['isNull', 0, undefined, false],
    ['isNotNull', 0, undefined, true],
    ['isNotNull', null, undefined, false],
    ['isEmpty', '', undefined, true],
    ['isEmpty', ' ', undefined, false],
  ] as [string, unknown, unknown, boolean][])(
    '%s(%j, %j) is %s',
    (operator, value, checkValue, expected) => {
      expect(checkConditionResult(value, checkValue, operator)).toBe(expected);
    },
  );

  it('normalises the bare = and != aliases', () => {
    expect(checkConditionResult(5, '5', '=')).toBe(true);
    expect(checkConditionResult(5, '6', '!=')).toBe(true);
  });

  it('isIn returns membership without mutating the value (carried fix)', () => {
    expect(checkConditionResult('b', ['a', 'b'], 'isIn')).toBe(true);
    expect(checkConditionResult('z', ['a', 'b'], 'isIn')).toBe(false);
  });

  it('isNotIn returns negated membership (carried fix)', () => {
    expect(checkConditionResult('z', ['a', 'b'], 'isNotIn')).toBe(true);
    expect(checkConditionResult('a', ['a', 'b'], 'isNotIn')).toBe(false);
  });

  it('isBetween is inclusive and tolerates reversed bounds', () => {
    expect(checkConditionResult(5, [1, 10], 'isBetween')).toBe(true);
    expect(checkConditionResult(5, [10, 1], 'isBetween')).toBe(true);
    expect(checkConditionResult(11, [1, 10], 'isBetween')).toBe(false);
    expect(checkConditionResult(1, [1, 10], 'isBetween')).toBe(true);
  });

  it('unknown operators return false, never undefined (carried fix)', () => {
    expect(checkConditionResult('a', 'a', 'wibble')).toBe(false);
  });
});

describe('checkSwitchCondition', () => {
  const options = [
    {
      id: 'c1',
      conditions: [{ property: 'input.kind', checkValue: 'left', checkOperator: '===' }],
    },
    {
      id: 'c2',
      conditions: [
        { property: 'input.kind', checkValue: 'right', checkOperator: '===' },
        { property: 'input.count', checkValue: '3', checkOperator: '>=' },
      ],
    },
  ];

  it('returns the first matching branch as source-<id>', () => {
    expect(checkSwitchCondition(options, { kind: 'left' })).toEqual(['source-c1']);
    expect(checkSwitchCondition(options, { kind: 'right', count: 5 })).toEqual(['source-c2']);
  });

  it('requires every condition in a branch to hold', () => {
    expect(checkSwitchCondition(options, { kind: 'right', count: 1 })).toEqual(['source-default']);
  });

  it('falls back to source-default with no options or no match', () => {
    expect(checkSwitchCondition(undefined, {})).toEqual(['source-default']);
    expect(checkSwitchCondition(options, { kind: 'neither' })).toEqual(['source-default']);
  });

  it('resolves ctx.input.-prefixed paths and passes literals through', () => {
    const literal = [
      { id: 'lit', conditions: [{ property: 42, checkValue: '42', checkOperator: '===' }] },
    ];
    expect(checkSwitchCondition(literal, {})).toEqual(['source-lit']);
    const prefixed = [
      { id: 'p', conditions: [{ property: 'ctx.input.deep.value', checkValue: 'x', checkOperator: '===' }] },
    ];
    expect(checkSwitchCondition(prefixed, { deep: { value: 'x' } })).toEqual(['source-p']);
  });
});

describe('partitionTargets', () => {
  it('splits targets into selected and orphaned by handle', () => {
    const result = partitionTargets(
      [
        { id: 'n1', handle: 'source-c1' },
        { id: 'n2', handle: 'source-default' },
        { id: 'n3', handle: 'source-c2' },
      ],
      ['source-c1'],
    );
    expect(result.selectedTargetIds).toEqual(['n1']);
    expect(result.orphanedTargetIds).toEqual(['n2', 'n3']);
  });

  it('treats a missing handle as source-default', () => {
    const result = partitionTargets([{ id: 'n1' }], ['source-default']);
    expect(result.selectedTargetIds).toEqual(['n1']);
    expect(result.orphanedTargetIds).toEqual([]);
  });
});
