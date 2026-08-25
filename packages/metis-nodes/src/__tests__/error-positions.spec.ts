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
 * Error positions that point at the line the author wrote.
 *
 * Both languages ran the user's source inside something larger and reported
 * positions in THAT, so every line number a person was shown was two out. In
 * JavaScript the code was also spliced mid-line, so column 1 read as column 46:
 * a mistake on line 1 column 5 was reported as `[<isolated-vm>:3:51]`.
 *
 * A line number that lies is worse than none, and it is about to be worse
 * again, because the editor is getting a gutter that will mark whatever these
 * say.
 */
import { describe, it, expect } from 'vitest';
import { JS_PRELUDE_LINES, PY_PRELUDE_LINES, retargetJsPositions, retargetPythonTraceback } from '../error-positions.js';

describe('JavaScript positions', () => {
  it('subtracts the wrapper and names the line in plain words', () => {
    expect(retargetJsPositions('Unexpected number [<isolated-vm>:3:51]')).toBe(
      'Unexpected number [line 1, column 51]',
    );
  });

  it('maps a mistake further down the file', () => {
    // User line 3 is wrapper line 5. This is the case the gutter marks.
    expect(retargetJsPositions("Unexpected identifier 'b' [<isolated-vm>:5:9]")).toBe(
      "Unexpected identifier 'b' [line 3, column 9]",
    );
  });

  it('rewrites every position in a stack, not just the first', () => {
    const stack = 'ReferenceError: x is not defined\n    at <isolated-vm>:4:1\n    at <isolated-vm>:6:3';
    expect(retargetJsPositions(stack)).toBe(
      'ReferenceError: x is not defined\n    at line 2, column 1\n    at line 4, column 3',
    );
  });

  it('leaves a position inside our own wrapper alone', () => {
    // Line 1 and 2 are the harness, not the author's code. Reporting "line -1"
    // would be worse than saying nothing, and it is our bug to find, not theirs.
    expect(retargetJsPositions('boom [<isolated-vm>:1:5]')).toBe('boom [<isolated-vm>:1:5]');
  });

  it('leaves a message with no position untouched', () => {
    expect(retargetJsPositions('Script execution timed out.')).toBe('Script execution timed out.');
  });

  it('agrees with the constant the wrapper is built from', () => {
    // If the wrapper grows a line and this is not updated, every number shifts
    // again silently. Pinned so that cannot happen quietly.
    expect(JS_PRELUDE_LINES).toBe(2);
  });
});

describe('Python tracebacks', () => {
  const traceback = [
    'Traceback (most recent call last):',
    '  File "/var/folders/w5/T/metis-py-KH4NRh/step.py", line 4, in <module>',
    '    print(json.dumps({"x": input["n"]}))',
    'KeyError: \'n\'',
  ].join('\n');

  it('subtracts the preamble so the line is the one they wrote', () => {
    expect(retargetPythonTraceback(traceback)).toContain('line 2, in <module>');
    expect(retargetPythonTraceback(traceback)).not.toContain('line 4');
  });

  it('drops the temp path, which tells the reader nothing and leaks one', () => {
    const out = retargetPythonTraceback(traceback);
    expect(out).not.toContain('/var/folders');
    expect(out).not.toContain('step.py');
    expect(out).toContain('your code');
  });

  it('keeps the error itself intact', () => {
    expect(retargetPythonTraceback(traceback)).toContain("KeyError: 'n'");
  });

  it('leaves a line inside the preamble alone', () => {
    const inPreamble = '  File "/tmp/metis-py-x/step.py", line 2, in <module>';
    expect(retargetPythonTraceback(inPreamble)).toBe(inPreamble);
  });

  it('agrees with the preamble the runner actually writes', () => {
    expect(PY_PRELUDE_LINES).toBe(2);
  });
});
