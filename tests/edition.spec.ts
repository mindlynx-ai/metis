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
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEditionPackages } from '../scripts/build-edition.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('edition profile', () => {
  it('the open edition resolves to open packages only', () => {
    const included = resolveEditionPackages(repoRoot, 'open') as string[];
    expect(included).toContain('metis-ports');
    expect(included).toContain('metis-engine');
    expect(included).not.toContain('example-gated');
  });

  it('the helix edition resolves to the full set with no source edit', () => {
    const included = resolveEditionPackages(repoRoot, 'helix') as string[];
    expect(included).toContain('metis-ports');
    expect(included).toContain('example-gated');
  });

  it('an unknown edition is rejected', () => {
    expect(() => resolveEditionPackages(repoRoot, 'enterprise')).toThrow(/unknown edition/i);
  });

  it('the open build physically omits gated modules; the flag includes them', () => {
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-edition.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, METIS_EDITION: 'open' },
      stdio: 'pipe',
    });
    expect(existsSync(join(repoRoot, 'packages', 'metis-ports', 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(repoRoot, 'packages', 'example-gated', 'dist'))).toBe(false);

    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-edition.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, METIS_EDITION: 'helix' },
      stdio: 'pipe',
    });
    expect(existsSync(join(repoRoot, 'packages', 'example-gated', 'dist', 'index.js'))).toBe(true);
  }, 120_000);
});
