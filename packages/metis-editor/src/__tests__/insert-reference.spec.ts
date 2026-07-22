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
// The DOM helpers (isReferenceTarget, insertAtCursor) are proven end to end in
// a real browser by variables.spec.ts; the pure cursor maths is unit-tested
// here so it needs no DOM environment (the editor suite ships none).
import { describe, it, expect } from 'vitest';
import { computeInsertion } from '../builder/inspector/insert-reference.js';

describe('computeInsertion', () => {
  it('inserts at a collapsed cursor and returns the caret after the text', () => {
    expect(computeInsertion('Hello ', 6, 6, '{{x}}')).toEqual({ value: 'Hello {{x}}', caret: 11 });
  });
  it('replaces a selection', () => {
    expect(computeInsertion('Hello NAME!', 6, 10, '{{x}}')).toEqual({ value: 'Hello {{x}}!', caret: 11 });
  });
  it('inserts at the start', () => {
    expect(computeInsertion('world', 0, 0, 'hello ')).toEqual({ value: 'hello world', caret: 6 });
  });
  it('clamps an out-of-range cursor to the end (append)', () => {
    expect(computeInsertion('abc', 999, 999, 'Z')).toEqual({ value: 'abcZ', caret: 4 });
  });
  it('clamps a negative start to zero', () => {
    expect(computeInsertion('abc', -5, -5, 'Z')).toEqual({ value: 'Zabc', caret: 1 });
  });
});
