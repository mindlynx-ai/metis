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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataGateway, MemoryAdapter } from '@mindlynx/metis-data-gateway';
import { ConnectorRegistry, registerConnectorTable } from '@mindlynx/metis-nodes';
import {
  getConnectorCatalogue,
  EXTRA_CONNECTORS,
  type ConnectorCatalogueRecord,
} from '@mindlynx/metis-catalogue';

// The default seed = the frozen top-100 plus the extra wired HTTP connectors.
const SEED_TOTAL = 100 + EXTRA_CONNECTORS.length;
import {
  seedConnectors,
  seedConnectorsIfEmpty,
  formatConnectorList,
  DEFAULT_TENANT,
} from '../connectors.js';
import { runCli } from '../cli.js';

function registry() {
  const gateway = new DataGateway(new MemoryAdapter());
  registerConnectorTable(gateway);
  return new ConnectorRegistry(gateway);
}

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

describe('connector catalogue seeder', () => {
  it('seeds the full top-100 catalogue plus the extra wired connectors, no skips', async () => {
    const reg = registry();
    const result = await seedConnectors(reg, DEFAULT_TENANT);
    expect(result.total).toBe(SEED_TOTAL);
    expect(result.seeded).toBe(SEED_TOTAL);
    expect(result.skipped).toEqual([]);
    const all = await reg.list(DEFAULT_TENANT);
    expect(all).toHaveLength(SEED_TOTAL);
    expect(all.map((c) => c.connectorId)).toContain('resend');
  });

  it('preserves verified operations and the premium tier through seeding', async () => {
    const reg = registry();
    await seedConnectors(reg, DEFAULT_TENANT);
    const slack = await reg.get(DEFAULT_TENANT, 'slack');
    expect(slack?.operations?.some((op) => op.name === 'postMessage' && op.method === 'POST')).toBe(true);
    const salesforce = await reg.get(DEFAULT_TENANT, 'salesforce');
    expect(salesforce?.tier).toBe('premium');
  });

  it('seedConnectorsIfEmpty seeds once then no-ops', async () => {
    const reg = registry();
    const first = await seedConnectorsIfEmpty(reg, DEFAULT_TENANT);
    expect(first?.seeded).toBe(SEED_TOTAL);
    const second = await seedConnectorsIfEmpty(reg, DEFAULT_TENANT);
    expect(second).toBeUndefined();
  });

  it('skips a malformed record without aborting the seed', async () => {
    const reg = registry();
    const catalogue = [
      ...getConnectorCatalogue().connectors.slice(0, 2),
      {
        connectorId: 'broken',
        name: 'Broken',
        baseUrl: 'ftp://nope',
        authScheme: 'none',
        tier: 'open',
      } as ConnectorCatalogueRecord,
    ];
    const result = await seedConnectors(reg, DEFAULT_TENANT, { catalogue });
    expect(result.seeded).toBe(2);
    expect(result.skipped.map((s) => s.connectorId)).toEqual(['broken']);
  });

  it('formats a readable list with tier and wire columns', async () => {
    const reg = registry();
    await seedConnectors(reg, DEFAULT_TENANT);
    const text = formatConnectorList(await reg.list(DEFAULT_TENANT));
    expect(text).toContain('ID');
    expect(text).toContain('TIER');
    expect(text).toMatch(/slack .*open/);
  });
});

describe('metis connectors CLI', () => {
  it('seeds then lists connectors in a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-connectors-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });

    const seed = capture();
    const seedCode = await runCli(['connectors', 'seed'], {
      cwd: dir,
      stdout: seed.write,
      stderr: seed.write,
    });
    expect(seedCode).toBe(0);
    expect(seed.text()).toMatch(new RegExp(`Seeded ${SEED_TOTAL} of ${SEED_TOTAL} connectors`));

    const list = capture();
    const listCode = await runCli(['connectors', 'list'], {
      cwd: dir,
      stdout: list.write,
      stderr: list.write,
    });
    expect(listCode).toBe(0);
    expect(list.text()).toContain(`${SEED_TOTAL} connectors registered.`);
    expect(list.text()).toContain('slack');
  });

  it('rejects an unknown connectors subcommand', async () => {
    const out = capture();
    const code = await runCli(['connectors', 'wibble'], {
      cwd: tmpdir(),
      stdout: out.write,
      stderr: out.write,
    });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/usage: metis connectors/);
  });
});
