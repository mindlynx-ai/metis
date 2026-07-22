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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingHeaders } from '../scripts/check-headers.mjs';
import { findStyleViolations } from '../scripts/check-style.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('quality harness', () => {
  it('every source file carries the Apache-2.0 header', () => {
    const missing = findMissingHeaders(repoRoot) as string[];
    expect(missing).toEqual([]);
  });

  it('no file contains an em dash or a deferred-work marker', () => {
    const violations = findStyleViolations(repoRoot) as { file: string; rule: string }[];
    expect(violations).toEqual([]);
  });
});
