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
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runModuleBoundaryGate } from '../gates/gate1-module-boundary.mjs';
import { runNoAwsSdkGate } from '../gates/gate2-no-aws-sdk.mjs';
import { runCatalogueTierGate } from '../gates/gate3-catalogue-tier.mjs';
import { runIdentifierScanGate } from '../gates/gate4-identifier-scan.mjs';
import { runStandaloneBootGate } from '../gates/gate5-standalone-boot.mjs';
import { runDocAllowlistGate } from '../gates/gate6-doc-allowlist.mjs';

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

  it('gate 2 also catches the SDK packages outside the v3 scope', () => {
    const planted = runNoAwsSdkGate(join(fixtures, 'gate-2')) as Violation[];
    const details = planted.map((v) => v.detail ?? '');
    // Matching on the '@aws-sdk/' scope alone let v2 and the crypto packages in.
    expect(details.some((d) => d.includes('"aws-sdk"'))).toBe(true);
    expect(details.some((d) => d.includes('@aws-crypto/'))).toBe(true);
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

  it('gate 4 reads the files an extension test walked past', () => {
    const planted = runIdentifierScanGate(join(fixtures, 'gate-4')) as Violation[];
    const byFile = new Map(planted.map((v) => [v.file, v.detail]));
    // extname('.env') is '', so the gate's own '.env' extension entry could
    // never match one; a Dockerfile and a deploy state file have none either.
    expect(byFile.get('.env')).toBe('aws-access-key');
    expect(byFile.get('compose/Dockerfile')).toBe('private-key-block');
    expect(byFile.get('deploy/aws/.state')).toBe('internal-vpc-address');
  });

  it('gate 4 scans a rendered SVG, which carries every label as literal text', () => {
    const planted = runIdentifierScanGate(join(fixtures, 'gate-4')) as Violation[];
    // docs/diagrams/*.svg ships to GitHub and the docs site. mermaid-cli
    // writes each node label into the file verbatim, so a host or an internal
    // product name drawn into a box leaks exactly as the prose beside it does
    // - and '.svg' was not in the extension set, so nothing read it at all.
    const svg = planted.filter((v) => v.file === 'docs/diagrams/leak.svg');
    expect(svg.map((v) => v.detail).sort()).toEqual([
      'internal-product-name',
      'internal-vpc-address',
    ]);
  });

  it('gate 4 knows the internal product names, in prose and not in source', () => {
    const planted = runIdentifierScanGate(join(fixtures, 'gate-4')) as Violation[];
    const named = planted.filter((v) => v.detail === 'internal-product-name').map((v) => v.file);
    expect(named.sort()).toEqual([
      'docs/diagrams/leak.svg',
      'docs/leak.md',
      'packages/metis-catalogue/src/nodeTypes.v1.json',
    ]);
    // An internal planning note names them on purpose and never ships; it is
    // still swept for everything else.
    const internal = planted.filter((v) => v.file === 'docs/internal/PLAN.md');
    expect(internal.map((v) => v.detail)).toEqual(['internal-vpc-address']);
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

  it('gate 5 fails a compose file it cannot parse instead of reporting success', () => {
    const planted = runStandaloneBootGate(join(fixtures, 'gate-5')) as Violation[];
    // Four-space keys and a trailing comment on `services:` are valid compose
    // the small reader cannot follow. It parsed to zero services, and zero
    // services meant zero violations: a pass on a file nobody had read.
    const unparsed = planted.filter((v) => v.rule === 'compose-unparsed');
    expect(unparsed.map((v) => v.file)).toEqual(['compose/docker-compose.unreadable.yml']);
  });

  it('gate 5 catches a published port on any bind address', () => {
    const planted = runStandaloneBootGate(join(fixtures, 'gate-5')) as Violation[];
    // '0.0.0.0:6379:6379' reaches the host as surely as '127.0.0.1:6379:6379',
    // but only the loopback spelling was matched.
    const ports = planted.filter((v) => v.rule === 'unexpected-published-port');
    expect(ports.some((v) => v.file === 'compose/docker-compose.yml' && v.detail?.includes('6379'))).toBe(true);
  });

  it('gate 5 reads every compose file in the directory, not just the hero one', () => {
    const planted = runStandaloneBootGate(join(fixtures, 'gate-5')) as Violation[];
    // The gate opened one hardcoded filename, so an overlay adding a database
    // or republishing a port was never looked at.
    expect([...new Set(planted.map((v) => v.file))].sort()).toEqual([
      'compose/docker-compose.extra.yml',
      'compose/docker-compose.unreadable.yml',
      'compose/docker-compose.yml',
    ]);
  });

  it('gate 6 fails on a planted internal doc and a planted package note', () => {
    const planted = runDocAllowlistGate(join(fixtures, 'gate-6')) as Violation[];
    // Neither was reachable before: the walk skipped any directory called
    // `internal`, and anything under packages/ that was not a README fell out
    // of scope. The fixture's own README.md is allowed, and stays unflagged.
    expect(planted.map((v) => v.file).sort()).toEqual([
      'docs/internal/PLAN.md',
      'packages/fake-pkg/NOTES.md',
    ]);
    expect(planted.map((v) => v.rule)).toContain('doc-allowlist');

    const real = runDocAllowlistGate(repoRoot) as Violation[];
    expect(real).toEqual([]);
  });

  it('gate 6 judges the index, so an untracked scratch note is not a violation', () => {
    const scratch = join(fixtures, 'gate-6', 'SCRATCH.md');
    writeFileSync(scratch, '# scratch\n\nUntracked, so it cannot ship.\n');
    try {
      const planted = runDocAllowlistGate(join(fixtures, 'gate-6')) as Violation[];
      expect(planted.map((v) => v.file)).not.toContain('SCRATCH.md');
    } finally {
      rmSync(scratch);
    }
  });

  it('npm run gates exits zero on the real tree', () => {
    const out = execFileSync(process.execPath, [join(repoRoot, 'gates', 'run-gates.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out).toContain('all gates passed');
  });
});
