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
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_PACKAGES = [
  'metis-ports',
  'metis-data-gateway',
  'metis-engine',
  'metis-nodes',
  'metis-catalogue',
  'metis-orchestrator',
  'metis-core',
  'metis-editor',
  'metis-cli',
] as const;

describe('workspace layout', () => {
  it('declares the packages workspace at the root', () => {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      workspaces?: string[];
    };
    expect(rootPkg.workspaces).toContain('packages/*');
  });

  it.each(EXPECTED_PACKAGES)('%s has a manifest, an edition marker and a source stub', (name) => {
    const pkgDir = join(repoRoot, 'packages', name);
    const manifestPath = join(pkgDir, 'package.json');
    expect(existsSync(manifestPath), `${name} package.json`).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      type?: string;
      license?: string;
      metis?: { edition?: string };
    };
    expect(manifest.name).toBe(`@mindlynx/${name}`);
    expect(manifest.type).toBe('module');
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.metis?.edition).toBe('open');
    // Libraries expose a barrel; the editor is an app booted from main.tsx.
    const entry = name === 'metis-editor' ? join('src', 'main.tsx') : join('src', 'index.ts');
    expect(existsSync(join(pkgDir, entry)), `${name} ${entry}`).toBe(true);
  });

  it('ships LICENSE and NOTICE at the root', () => {
    expect(readFileSync(join(repoRoot, 'LICENSE'), 'utf8')).toContain('Apache License');
    expect(readFileSync(join(repoRoot, 'NOTICE'), 'utf8')).toContain('Seillen');
  });
});
