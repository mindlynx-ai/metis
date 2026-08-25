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
 * Which grammar a long-form field is written in.
 *
 * Kept pure and in its own file for two reasons: it is the only part of the
 * editor that CAN be unit-tested (the editor suite ships no DOM), and three
 * different hosts need the same answer - the schema form, the SQL builder and
 * the connector operation params.
 */
import type { EditorLanguage } from './CodeEditor.js';

/** Field names whose grammar is fixed regardless of the step. */
const BY_NAME: Record<string, EditorLanguage> = {
  query: 'sql',
  html: 'html',
};

/** What the code step's `language` field maps to for highlighting. */
const BY_STEP_LANGUAGE: Record<string, EditorLanguage> = {
  javascript: 'javascript',
  python: 'python',
};

/**
 * @param name - the config field.
 * @param widget - what the schema form resolved it to.
 * @param config - the step's config, for a code step's own language choice.
 */
export function editorLanguageFor(
  name: string,
  widget: string,
  config: Record<string, unknown> | undefined,
): EditorLanguage {
  if (widget === 'json') return 'json';
  if (name === 'code' || name === 'script') {
    const chosen = String(config?.language ?? '').toLowerCase();
    // An unrecognised value falls to the catalogue default rather than to plain
    // text: the step will run as JavaScript, so it should look like it.
    return BY_STEP_LANGUAGE[chosen] ?? 'javascript';
  }
  // `template` and `text` deliberately fall through. They could hold anything,
  // and a wrong grammar colours correct code as if it were broken - worse than
  // no colour at all.
  return BY_NAME[name] ?? 'text';
}
