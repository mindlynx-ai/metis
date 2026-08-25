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
 * Syntax checking for the code workbench. A sibling of `api.ts` rather than a
 * member of it for the same reason `uplift-api.ts` is: it shares the bearer and
 * error rules through `request`, and `api.ts` is at its line cap.
 */
import { request } from './api.js';

export interface SyntaxVerdict {
  ok: boolean;
  message?: string;
  line?: number;
  column?: number;
}

/**
 * Does this code parse? Answered by the same V8 or CPython that will run it,
 * not by a checker in the browser - which would pass `fetch(...)`, refuse
 * top-level `return`, and has nothing to say about Python at all. Parses only;
 * nothing is executed.
 */
export const validateCode = (language: string, code: string): Promise<SyntaxVerdict> =>
  request<SyntaxVerdict>('POST', '/api/code/validate', { language, code });
