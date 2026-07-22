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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runModuleBoundaryGate } from '../gates/gate1-module-boundary.mjs';
import { runNoAwsSdkGate } from '../gates/gate2-no-aws-sdk.mjs';
import { runCatalogueTierGate } from '../gates/gate3-catalogue-tier.mjs';
import { runIdentifierScanGate } from '../gates/gate4-identifier-scan.mjs';
import { runStandaloneBootGate } from '../gates/gate5-standalone-boot.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(repoRoot, 'gates', 'fixtures', 'violations');

interface Violation {
  file: string;
  rule: string;
  detail?: string;
}

describe('release gates', () => {
  it('gate 1 fails on a planted excluded-module import and passes on the tree', () => {
    const planted = runModuleBoundaryGate(join(fixtures, 'gate-1')) as Violation[];
    expect(planted.length).toBeGreaterThan(0);
    expect(planted.map((v) => v.rule)).toContain('banned-module-import');
    expect(planted.map((v) => v.rule)).toContain('open-imports-gated-package');

    const real = runModuleBoundaryGate(repoRoot) as Violation[];
    expect(real).toEqual([]);
  });

  it('gate 2 fails on a planted @aws-sdk import and passes on the tree', () => {
    const planted = runNoAwsSdkGate(join(fixtures, 'gate-2')) as Violation[];
    expect(planted.length).toBeGreaterThan(0);
    expect(planted[0]?.rule).toBe('no-aws-sdk');

    const real = runNoAwsSdkGate(repoRoot) as Violation[];
    expect(real).toEqual([]);
  });

  it('gate 3 fails on a planted paid catalogue entry and passes on the tree', () => {
    const planted = runCatalogueTierGate(join(fixtures, 'gate-3')) as Violation[];
    expect(planted.length).toBeGreaterThan(0);
    expect(planted.map((v) => v.rule)).toContain('catalogue-closed-category');

    const real = runCatalogueTierGate(repoRoot) as Violation[];
    expect(real).toEqual([]);
  });

  it('gate 4 fails on a planted internal identifier and passes on the tree', () => {
    const planted = runIdentifierScanGate(join(fixtures, 'gate-4')) as Violation[];
    expect(planted.length).toBeGreaterThan(0);
    expect(planted.map((v) => v.rule)).toContain('banned-identifier');

    const real = runIdentifierScanGate(repoRoot) as Violation[];
    expect(real).toEqual([]);
  });

  it('gate 5 fails on a planted external-egress compose and passes on the tree', () => {
    const planted = runStandaloneBootGate(join(fixtures, 'gate-5')) as Violation[];
    expect(planted.length).toBeGreaterThan(0);
    const rules = planted.map((v) => v.rule);
    expect(rules).toContain('external-image');
    expect(rules).toContain('external-egress');
    expect(rules).toContain('unexpected-published-port');

    const real = runStandaloneBootGate(repoRoot) as Violation[];
    expect(real).toEqual([]);
  });

  it('npm run gates exits zero on the real tree', () => {
    const out = execFileSync(process.execPath, [join(repoRoot, 'gates', 'run-gates.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out).toContain('all gates passed');
  });
});
