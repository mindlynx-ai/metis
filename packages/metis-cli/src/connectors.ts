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
 * Seeding the connector catalogue into the connectors table. The
 * top-100 definitions ship as data in @mindlynx/metis-catalogue; this
 * bridges them to the ConnectorRegistry so `metis connectors seed`
 * populates a project and `metis up` seeds on first boot. Records are
 * pre-validated; a malformed record is skipped (never aborts the seed).
 */
import {
  getConnectorCatalogue,
  EXTRA_CONNECTORS,
  type ConnectorCatalogueRecord,
} from '@mindlynx/metis-catalogue';
import { renderTable } from './render-table.js';
import {
  validateConnectorRecord,
  type ConnectorRegistry,
  type ConnectorRecord,
} from '@mindlynx/metis-nodes';

export const DEFAULT_TENANT = 't1';

export interface SeedResult {
  seeded: number;
  skipped: { connectorId: string; problems: string[] }[];
  total: number;
}

/** Register every valid catalogue record for a tenant; skip malformed ones. */
export async function seedConnectors(
  registry: ConnectorRegistry,
  tenantId: string = DEFAULT_TENANT,
  options: { catalogue?: ConnectorCatalogueRecord[] } = {},
): Promise<SeedResult> {
  // The frozen top-100 plus the extra wired HTTP connectors (Resend, ...) which
  // live outside connectors.v1.json but still need a registry record so their
  // node type can resolve base URL, auth scheme and operations at run time. The
  // database connectors are intentionally excluded (non-HTTP baseUrl; their
  // node reads credentials directly).
  const records = options.catalogue ?? [...getConnectorCatalogue().connectors, ...EXTRA_CONNECTORS];
  const skipped: SeedResult['skipped'] = [];
  let seeded = 0;
  for (const record of records) {
    const asRecord = record as unknown as ConnectorRecord;
    const problems = validateConnectorRecord(asRecord);
    if (problems.length > 0) {
      skipped.push({ connectorId: record.connectorId, problems });
      continue;
    }
    await registry.register(tenantId, asRecord);
    seeded += 1;
  }
  return { seeded, skipped, total: records.length };
}

/** Seed only when the tenant has no connectors yet (idempotent first-boot hook). */
export async function seedConnectorsIfEmpty(
  registry: ConnectorRegistry,
  tenantId: string = DEFAULT_TENANT,
): Promise<SeedResult | undefined> {
  const existing = await registry.list(tenantId);
  if (existing.length > 0) return undefined;
  return seedConnectors(registry, tenantId);
}

/** A compact, aligned table of the registered connectors for the CLI. */
export function formatConnectorList(records: ConnectorRecord[]): string {
  const sorted = [...records].sort((a, b) => a.connectorId.localeCompare(b.connectorId));
  const rows = sorted.map((record) => {
    const ops = record.operations?.length ?? 0;
    const plural = ops === 1 ? '' : 's';
    const wire = ops > 0 ? `${ops} op${plural}` : 'browse';
    return [
      record.connectorId,
      record.tier ?? 'open',
      String(record.priority ?? ''),
      wire,
      record.name,
    ];
  });
  return renderTable(['ID', 'TIER', 'PRI', 'WIRE', 'NAME'], rows);
}
