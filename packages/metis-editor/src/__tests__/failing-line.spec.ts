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
 * Finding the line to mark in the gutter.
 *
 * Only worth doing because the engine's positions are now the author's own line
 * numbers (see error-positions.ts in metis-nodes). Marking a line from a number
 * that was two out would have been worse than marking nothing.
 */
import { describe, it, expect } from 'vitest';
import { failingLineOf } from '../builder/inspector/failing-line.js';

describe('failingLineOf', () => {
  it('reads the JavaScript form', () => {
    expect(failingLineOf("Unexpected identifier 'b' [line 3, column 10]")).toBe(3);
  });

  it('reads the Python form', () => {
    expect(failingLineOf('Traceback...\n  In your code, line 2, in <module>\nKeyError')).toBe(2);
  });

  it('takes the LAST frame of a Python traceback, which is where it broke', () => {
    // A traceback reads outermost first. The innermost frame is the one that
    // actually failed, and the one somebody wants their cursor on.
    const trace = 'In your code, line 2, in <module>\nIn your code, line 7, in helper';
    expect(failingLineOf(trace)).toBe(7);
  });

  it('takes the FIRST position from a JavaScript stack, which is the throw site', () => {
    // A JS stack reads innermost first - the opposite of Python. Same intent,
    // opposite end.
    expect(failingLineOf('boom\n    at line 4, column 1\n    at line 9, column 3')).toBe(4);
  });

  it('has no answer when the message carries no position', () => {
    expect(failingLineOf('Script execution timed out.')).toBeUndefined();
    expect(failingLineOf('the data step needs a connection')).toBeUndefined();
    expect(failingLineOf(undefined)).toBeUndefined();
    expect(failingLineOf('')).toBeUndefined();
  });

  it('ignores a line number that could not be real', () => {
    // Line 0 does not exist in any editor gutter; marking it would highlight
    // nothing and look broken.
    expect(failingLineOf('boom [line 0, column 1]')).toBeUndefined();
  });
});
