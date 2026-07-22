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
 * Dev-only generator for the connector catalogue (`connectors.v1.json`).
 * NOT on the runtime path - run by hand with `npx tsx` to regenerate the
 * artefact from three committed inputs under `data/`:
 *
 *   - catalogue-top100.json - the frozen merged top-100 popularity
 *     ranking. Factual API-surface metadata harvested from the six
 *     open-source connector ecosystems (n8n/activepieces/pipedream/
 *     airbyte/nifi/composio), deduplicated, market-pinned, priority-
 *     overlaid.
 *   - connector-bases.json - curated base URL + auth scheme per app,
 *     authored from each vendor's public API docs.
 *   - verified-operations.json - real method + path per operation for
 *     the wireable core, authored from public docs. n8n (fair-code) and
 *     Activepieces (MIT) informed WHICH operations matter as
 *     inspiration only; no source was copied.
 *
 * The output is the "connector as data" catalogue: one record per app,
 * seeded into the connectors table by the seeder. Records with verified
 * operations are runnable; the rest are browsable definitions whose
 * operations are filled incrementally.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConnectorCatalogue,
  ConnectorCatalogueRecord,
  ConnectorCatalogueOperation,
} from './loader.js';

type ConnectorCatalogueEvent = NonNullable<ConnectorCatalogueRecord['events']>[number];

interface TopApp {
  rank: number;
  canonical: string;
  name: string;
  category: string;
  priority: string;
  authMethod: string;
  sourceCount: number;
  sources: string;
}
interface BaseRow {
  baseUrl: string;
  authScheme: 'bearer' | 'header' | 'basic' | 'none';
  authHeaderName?: string;
  headers?: Record<string, string>;
  tier?: 'premium';
  site?: boolean;
}
type RawOperation = Omit<ConnectorCatalogueOperation, 'wireStatus'>;

const here = dirname(fileURLToPath(import.meta.url));
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(here, name), 'utf8')) as T;

/** Stable connector id: lowercase, non-alphanumeric runs to single dashes. */
function slug(canonical: string): string {
  return canonical
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Cleaned display name: drop harvest suffixes like " (source)" / " Bot". */
function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(/ ?\((?:source|destination)\)$/i, '')
    .replace(/ (?:bot|oauth)$/i, '')
    .trim();
}

const LICENCE_BY_SOURCE: Record<string, string> = {
  n8n: 'sustainable-use (inspiration)',
  activepieces: 'MIT',
  pipedream: 'catalogue-metadata',
  airbyte: 'catalogue-metadata',
  nifi: 'catalogue-metadata',
  composio: 'catalogue-metadata',
};

function primarySource(sources: string): string {
  const first = sources
    .replace(/;/g, ',')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .find(Boolean);
  return first ?? 'catalogue';
}

export function generateConnectors(): ConnectorCatalogue {
  const top = readJson<{ generated: string; apps: TopApp[] }>('data/catalogue-top100.json');
  const bases = readJson<Record<string, BaseRow>>('data/connector-bases.json');
  const verified = readJson<Record<string, RawOperation[]>>('data/verified-operations.json');
  const eventsBySource = readJson<Record<string, unknown>>('data/connector-events.json');

  const connectors: ConnectorCatalogueRecord[] = top.apps.map((app) => {
    const base = bases[app.canonical];
    if (!base) throw new Error(`no base URL curated for "${app.canonical}"`);
    const ops = verified[app.canonical];
    const operations: ConnectorCatalogueOperation[] | undefined = ops?.map((op) => ({
      ...op,
      wireStatus: 'verified' as const,
    }));
    const source = primarySource(app.sources);
    const record: ConnectorCatalogueRecord = {
      connectorId: slug(app.canonical),
      name: cleanName(app.name),
      baseUrl: base.baseUrl,
      authScheme: base.authScheme,
      tier: base.tier ?? 'open',
      category: app.category,
      priority: (['P0', 'P1', 'P2'].includes(app.priority) ? app.priority : 'P2') as 'P0' | 'P1' | 'P2',
      provenance: operations
        ? { source: 'public-docs', licence: 'n8n/activepieces (inspiration)' }
        : { source, licence: LICENCE_BY_SOURCE[source] ?? 'catalogue-metadata' },
    };
    if (base.authHeaderName) record.authHeaderName = base.authHeaderName;
    if (base.headers && Object.keys(base.headers).length > 0) record.headers = base.headers;
    if (operations && operations.length > 0) record.operations = operations;
    const events = eventsBySource[app.canonical];
    if (Array.isArray(events) && events.length > 0) record.events = events as ConnectorCatalogueEvent[];
    return record;
  });

  return {
    schemaVersion: '1',
    generated: top.generated,
    count: connectors.length,
    connectors,
  };
}

const OUTPUT = 'connectors.v1.json';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const catalogue = generateConnectors();
  writeFileSync(join(here, OUTPUT), `${JSON.stringify(catalogue, null, 2)}\n`);
  const verifiedCount = catalogue.connectors.filter((c) => (c.operations?.length ?? 0) > 0).length;
  const premiumCount = catalogue.connectors.filter((c) => c.tier === 'premium').length;
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${OUTPUT}: ${catalogue.count} connectors (${verifiedCount} wired, ${premiumCount} premium)`,
  );
}
