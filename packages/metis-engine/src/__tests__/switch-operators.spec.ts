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
 * Property-level coverage of the switch node's operator table
 * (checkConditionResult): each of the fifteen operators with a true and a
 * false case, the `=`/`!=` aliases, and the unknown-operator default. Semantics
 * are read straight from nodes/switch.ts (e.g. isEmpty is `value === ''`,
 * isNull is null-or-undefined), not assumed.
 */
import { describe, it, expect } from 'vitest';
import { checkConditionResult } from '../nodes/switch.js';

describe('checkConditionResult operators', () => {
  it('=== (and its alias =)', () => {
    expect(checkConditionResult(5, 5, '===')).toBe(true);
    expect(checkConditionResult(5, 6, '===')).toBe(false);
    expect(checkConditionResult('gold', 'gold', '=')).toBe(true);
    expect(checkConditionResult('gold', 'silver', '=')).toBe(false);
  });

  it('!== (and its alias !=)', () => {
    expect(checkConditionResult(5, 6, '!==')).toBe(true);
    expect(checkConditionResult(5, 5, '!==')).toBe(false);
    expect(checkConditionResult('gold', 'silver', '!=')).toBe(true);
    expect(checkConditionResult('gold', 'gold', '!=')).toBe(false);
  });

  it('<', () => {
    expect(checkConditionResult(3, 5, '<')).toBe(true);
    expect(checkConditionResult(5, 3, '<')).toBe(false);
  });

  it('>', () => {
    expect(checkConditionResult(5, 3, '>')).toBe(true);
    expect(checkConditionResult(3, 5, '>')).toBe(false);
  });

  it('<=', () => {
    expect(checkConditionResult(5, 5, '<=')).toBe(true);
    expect(checkConditionResult(6, 5, '<=')).toBe(false);
  });

  it('>=', () => {
    expect(checkConditionResult(5, 5, '>=')).toBe(true);
    expect(checkConditionResult(4, 5, '>=')).toBe(false);
  });

  it('contains', () => {
    expect(checkConditionResult('hello world', 'world', 'contains')).toBe(true);
    expect(checkConditionResult('hello world', 'zzz', 'contains')).toBe(false);
  });

  it('isTrue', () => {
    expect(checkConditionResult(true, null, 'isTrue')).toBe(true);
    expect(checkConditionResult(false, null, 'isTrue')).toBe(false);
  });

  it('isFalse', () => {
    expect(checkConditionResult(false, null, 'isFalse')).toBe(true);
    expect(checkConditionResult(true, null, 'isFalse')).toBe(false);
  });

  it('isNull (null or undefined)', () => {
    expect(checkConditionResult(null, null, 'isNull')).toBe(true);
    expect(checkConditionResult(undefined, null, 'isNull')).toBe(true);
    expect(checkConditionResult('x', null, 'isNull')).toBe(false);
  });

  it('isNotNull', () => {
    expect(checkConditionResult('x', null, 'isNotNull')).toBe(true);
    expect(checkConditionResult(null, null, 'isNotNull')).toBe(false);
  });

  it('isEmpty (strictly value === "")', () => {
    expect(checkConditionResult('', null, 'isEmpty')).toBe(true);
    expect(checkConditionResult('x', null, 'isEmpty')).toBe(false);
  });

  it('isIn (checkValue is an array)', () => {
    expect(checkConditionResult('b', ['a', 'b', 'c'], 'isIn')).toBe(true);
    expect(checkConditionResult('z', ['a', 'b', 'c'], 'isIn')).toBe(false);
  });

  it('isNotIn (checkValue is an array)', () => {
    expect(checkConditionResult('z', ['a', 'b', 'c'], 'isNotIn')).toBe(true);
    expect(checkConditionResult('a', ['a', 'b', 'c'], 'isNotIn')).toBe(false);
  });

  it('isBetween (checkValue is a [min, max] array)', () => {
    expect(checkConditionResult(5, [1, 10], 'isBetween')).toBe(true);
    expect(checkConditionResult(15, [1, 10], 'isBetween')).toBe(false);
  });

  it('an unknown operator returns false', () => {
    expect(checkConditionResult('x', 'y', 'bogusOperator')).toBe(false);
  });
});
