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
 * Which line of the author's code a failed run blames.
 *
 * Only worth having because the engine now reports the author's own line
 * numbers. Before that they were two out, and a gutter marker driven from them
 * would have pointed confidently at the wrong line - worse than no marker.
 *
 * Pure, so it is unit-tested; the gutter it feeds can only be seen in a browser.
 */

/** `[line 3, column 10]` and `at line 4, column 1` - the JavaScript shapes. */
const JS_POSITION = /line (\d+), column \d+/;

/** `In your code, line 2, in <module>` - the Python shape. */
const PY_FRAME = /In your code, line (\d+)/g;

/**
 * @param message - the run's error, already retargeted by the engine.
 * @returns a 1-based line, or undefined when the message carries no position.
 */
export function failingLineOf(message: string | undefined): number | undefined {
  if (!message) return undefined;

  // Python first, and the LAST frame: a traceback reads outermost to innermost,
  // so the innermost frame is where it actually broke and where a cursor wants
  // to be.
  const frames = [...message.matchAll(PY_FRAME)];
  const last = frames.at(-1);
  if (last) return atLeastOne(Number(last[1]));

  // A JavaScript stack reads the other way round - innermost first - so the
  // first position is the throw site. Same intent, opposite end.
  const js = JS_POSITION.exec(message);
  return js ? atLeastOne(Number(js[1])) : undefined;
}

/** Line 0 exists in no gutter; marking it would highlight nothing. */
function atLeastOne(line: number): number | undefined {
  return Number.isFinite(line) && line >= 1 ? line : undefined;
}
