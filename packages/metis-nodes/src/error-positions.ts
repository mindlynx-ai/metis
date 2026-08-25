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
 * Error positions that point at the line the author actually wrote.
 *
 * Neither language runs the user's source on its own. JavaScript goes inside an
 * async wrapper so `return` and `await` work at the top level; Python gets a
 * preamble that binds `input` from stdin. Both used to report positions in THAT
 * larger file, so every line number a person saw was two out - and JavaScript
 * spliced the code mid-line as well, so column 1 read as column 46.
 *
 * A wrong line number is worse than no line number: it sends someone to the
 * wrong place with confidence. It is about to matter more, because the editor's
 * gutter marks whatever these say.
 *
 * Pure string work against a known constant, so it is unit-tested with no DOM,
 * no isolate and no interpreter - the same shape as `computeInsertion`.
 */

/**
 * The harness lines above the user's first line, and the count derived from
 * them.
 *
 * Both live here on purpose. When the count was a hand-written `2` sitting in a
 * different file from the wrapper it described, nothing stopped the wrapper
 * growing a line and every reported position silently shifting again.
 * `code-node.ts` builds the wrapper FROM this array, so the two cannot drift.
 */
export const JS_PRELUDE: readonly string[] = [
  '(async () => {',
  'const __value = await (async () => {',
];

export const JS_PRELUDE_LINES = JS_PRELUDE.length;

/**
 * The Python preamble, and the count derived from it. Same reasoning as
 * JS_PRELUDE: `python-runner.ts` writes the file FROM this array.
 */
export const PY_PRELUDE: readonly string[] = [
  'import json,sys',
  'input = json.loads(sys.stdin.readline() or "null")',
];

export const PY_PRELUDE_LINES = PY_PRELUDE.length;

/** `<isolated-vm>:LINE:COLUMN`, wherever it appears - message or stack. */
const JS_POSITION = /<isolated-vm>:(\d+):(\d+)/g;

/**
 * Rewrite isolate positions to the author's own line numbers.
 *
 * A position inside the wrapper itself is left exactly as it was: reporting
 * "line -1" would be worse than saying nothing, and it is our bug to find
 * rather than theirs to puzzle over.
 */
export function retargetJsPositions(message: string, prelude = JS_PRELUDE_LINES): string {
  return message.replace(JS_POSITION, (whole, rawLine: string, column: string) => {
    const line = Number(rawLine) - prelude;
    return line >= 1 ? `line ${line}, column ${column}` : whole;
  });
}

/** `File "...", line N` - the only part of a traceback carrying a position. */
const PY_FRAME = /File "([^"]*)", line (\d+)/g;

/**
 * Rewrite traceback line numbers, and drop the temp path.
 *
 * The path is `/var/folders/.../metis-py-KH4NRh/step.py` - a scratch file the
 * reader has never heard of and which will not exist by the time they look. It
 * tells them nothing and leaks a filesystem path into a run log.
 */
export function retargetPythonTraceback(message: string, prelude = PY_PRELUDE_LINES): string {
  return message.replace(PY_FRAME, (whole, _path: string, rawLine: string) => {
    const line = Number(rawLine) - prelude;
    return line >= 1 ? `In your code, line ${line}` : whole;
  });
}
