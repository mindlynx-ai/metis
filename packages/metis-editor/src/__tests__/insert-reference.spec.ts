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
import { describe, it, expect, afterEach } from 'vitest';
// isReferenceTarget is not tested here: it needs HTMLTextAreaElement, and this
// suite has no DOM. Its Monaco exclusion is proven end to end by the chip
// insert in code-workbench.spec.ts, which would land in the wrong place - or
// nowhere - if the guard claimed Monaco's hidden textarea.
import {
  activeInsertHandle,
  computeInsertion,
  registerInsertHandle,
} from '../builder/inspector/insert-reference.js';

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

/**
 * The editor's route in.
 *
 * The DOM insert works by writing a native `value` setter and firing a
 * synthetic `input` event. Monaco's value lives in a model, not in an element,
 * and the only textarea it has is a hidden one for IME - so that insert would
 * appear to succeed and change nothing. The editor hands over a real insert
 * function for as long as it holds focus instead.
 *
 * Pure registry, no DOM, so it is unit-tested here rather than only in a
 * browser.
 */
describe('the editor insert handle', () => {
  afterEach(() => {
    const live = activeInsertHandle();
    if (live) registerInsertHandle(undefined, live);
  });

  it('has nothing registered to begin with', () => {
    expect(activeInsertHandle()).toBeUndefined();
  });

  it('hands back whatever the focused editor registered', () => {
    const insert = () => undefined;
    registerInsertHandle(insert);
    expect(activeInsertHandle()).toBe(insert);
  });

  it('clears on blur', () => {
    const insert = () => undefined;
    registerInsertHandle(insert);
    registerInsertHandle(undefined, insert);
    expect(activeInsertHandle()).toBeUndefined();
  });

  it('a stale blur does not steal the handle from whoever has focus now', () => {
    // Focus moves between two editors: the first one's focusout can arrive
    // AFTER the second one's focusin. Clearing blindly would leave nothing
    // registered while an editor is plainly focused, and the chip would go to
    // the clipboard with the cursor sitting right there.
    const first = () => undefined;
    const second = () => undefined;
    registerInsertHandle(first);
    registerInsertHandle(second);
    registerInsertHandle(undefined, first);
    expect(activeInsertHandle()).toBe(second);
  });
});
