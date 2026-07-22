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
 * The open node catalogue loader, ported from the origin
 * catalogue/index.ts shape: a static JSON contract, loaded once and
 * cached, overridable via NODE_CATALOGUE_PATH or an explicit path.
 * Every entry carries the NEW tier field; the open build ships only
 * tier "open" entries in the four open categories.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASE_CONNECTORS } from './database-connectors.js';
import { deriveKeywords } from './node-keywords.js';
import { EXTRA_CONNECTORS } from './extra-connectors.js';
import {
  credentialSchemaFor,
  brandColorFor,
  healthCheckFor,
  type CredentialFieldDef,
} from './connector-credentials.js';

export const OPEN_CATEGORIES: ReadonlySet<string> = new Set([
  'trigger',
  'logic',
  'transform',
  'integration',
]);

export const CLOSED_TYPE_PREFIXES = ['cortex.', 'skill.', 'approval.', 'tachyon.'];

export interface CatalogueEntry {
  type: string;
  category: string;
  /** The browse group in the picker (e.g. 'communication'); the app category. */
  group?: string;
  /** Search synonyms so the picker matches beyond the label. */
  keywords?: string[];
  tier: string;
  /** WHERE the node can run: on this machine, in the cloud, or either.
   *  Absent means 'local'. A 'both' entry pairs with an entitlement id. */
  execution?: 'local' | 'cloud' | 'both';
  /** The capability (e.g. 'cap.data') whose entitlement unlocks the cloud
   *  backend of a 'both' node, or a 'cloud' node entirely. */
  entitlement?: string;
  status?: string;
  handler_status?: string;
  alias_of?: string;
  versions?: string[];
  /** Long-form node documentation (markdown) for the inspector Guide tab. */
  docs?: string;
  configSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
  palette?: Record<string, unknown>;
}

export interface Catalogue {
  schemaVersion: string;
  edition?: string;
  entries: CatalogueEntry[];
}

let cached: Catalogue | undefined;

export interface GetCatalogueOptions {
  path?: string;
  reload?: boolean;
}

export function getCatalogue(options: GetCatalogueOptions = {}): Catalogue {
  if (cached && !options.reload) return cached;
  const path =
    options.path ??
    process.env.NODE_CATALOGUE_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), 'nodeTypes.v1.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Catalogue;
  // Enrich the built-in nodes with their picker group + search keywords (kept
  // here, not in the JSON data), then append the generated connector nodes.
  parsed.entries = [...parsed.entries.map(withBaseMeta), ...connectorNodeTypes()];
  cached = parsed;
  return parsed;
}

/** Picker group + search keywords for the built-in node types. */
const BASE_NODE_META: Record<string, { group?: string; keywords: string[] }> = {
  webhookconfig: { keywords: ['webhook', 'http', 'trigger', 'hook', 'incoming'] },
  scheduleconfig: { keywords: ['schedule', 'cron', 'timer', 'recurring', 'trigger'] },
  apiconfig: { keywords: ['api', 'endpoint', 'http', 'start', 'trigger'] },
  apiend: { keywords: ['api', 'response', 'end', 'return'] },
  signal: { keywords: ['signal', 'event', 'resume', 'wait'] },
  switch: { keywords: ['switch', 'branch', 'if', 'condition', 'route'] },
  logic: { keywords: ['logic', 'condition', 'branch', 'if'] },
  waituntil: { keywords: ['wait', 'delay', 'pause', 'until', 'timer'] },
  noop: { keywords: ['noop', 'no-op', 'nothing', 'pass', 'placeholder', 'label', 'junction'] },
  stopanderror: { keywords: ['stop', 'error', 'halt', 'fail', 'throw', 'abort', 'guard'] },
  merge: { keywords: ['merge', 'join', 'combine', 'append', 'union', 'fan-in', 'converge'] },
  loop: { keywords: ['loop', 'iterate', 'foreach', 'each', 'batch', 'repeat', 'split'] },
  filter: { keywords: ['filter', 'where', 'kept', 'discard', 'sift', 'select', 'condition'] },
  comparedatasets: { keywords: ['compare', 'diff', 'datasets', 'delta', 'sync', 'reconcile'] },
  code: { keywords: ['code', 'javascript', 'function', 'script', 'transform', 'js'] },
  sql: { group: 'data-flow', keywords: ['sql', 'query', 'database', 'postgres', 'select', 'transform', 'data'] },
  data: { group: 'data-flow', keywords: ['data', 'sql', 'query', 'database', 'postgres', 'select', 'table', 'fetch', 'transform', 'dataset', 'reference'] },
  api: { group: 'developer-tools', keywords: ['http', 'request', 'rest', 'api', 'fetch', 'url', 'call'] },
  connector: { group: 'developer-tools', keywords: ['connector', 'http', 'api', 'integration', 'connect'] },
  postgres: { group: 'data-flow', keywords: ['postgres', 'database', 'sql', 'query', 'db'] },
  sendgrid: { group: 'communication', keywords: ['sendgrid', 'email', 'mail', 'send', 'smtp'] },
};

function withBaseMeta(entry: CatalogueEntry): CatalogueEntry {
  const meta = BASE_NODE_META[entry.type];
  return meta ? { ...entry, group: meta.group ?? entry.group, keywords: meta.keywords } : entry;
}

/** Connectors that already have a hand-written node type (skip generation). */
const DEDICATED_CONNECTOR_NODES = new Set(['sendgrid']);

/**
 * A node type per WIRED connector (one with verified operations): a droppable,
 * bespoke step where you pick an operation and a connection. The node type IS
 * the connector id; the required `connectorId` field holds the chosen
 * connection (a connectorRef scoped to this connector's provider). Derived from
 * the connector catalogue, minus connectors with a dedicated node (sendgrid).
 */
export function connectorNodeTypes(): CatalogueEntry[] {
  return [...getConnectorCatalogue().connectors, ...EXTRA_CONNECTORS]
    .filter(
      (c) => (c.operations?.length ?? 0) > 0 && !DEDICATED_CONNECTOR_NODES.has(c.connectorId),
    )
    .map((connector) => ({
      type: connector.connectorId,
      category: 'integration',
      // The browse group is the connector's own category (communication, ...);
      // keywords let the picker match on more than the name.
      group: connector.category ?? 'other',
      keywords: deriveKeywords(
        connector.name,
        connector.category,
        (connector.operations ?? []).map((operation) => operation.name),
      ),
      tier: 'open',
      status: 'v1',
      execution: 'local',
      handler_status: 'ready',
      versions: ['1.0.0'],
      palette: {
        label: connector.name,
        icon: 'plug',
        colour: 'slate-500',
        description: `Use ${connector.name} in a workflow: choose an operation and a connection.`,
      },
      configSchema: {
        type: 'object',
        required: ['connectorId', 'operation'],
        properties: {
          connectorId: {
            type: 'string',
            title: 'Connection',
            description: `The ${connector.name} connection to authenticate with.`,
            'x-helix-widget': 'connectorRef',
            'x-helix-options': `/_resource/connectors?provider=${connector.connectorId}`,
          },
          operation: {
            type: 'string',
            title: 'Operation',
            enum: (connector.operations ?? []).map((operation) => operation.name),
          },
          params: {
            type: 'object',
            title: 'Parameters',
            description: 'Operation inputs (path placeholders, query and body values).',
            'x-helix-widget': 'operationParams',
          },
        },
      },
      outputSchema: { type: 'object' },
    }));
}

/** The generated connector node type ids (for handler registration). */
export function connectorNodeTypeIds(): string[] {
  return connectorNodeTypes().map((entry) => entry.type);
}

/** Resolve a node type to its canonical entry, following one alias hop. */
export function getEntry(catalogue: Catalogue, type: string): CatalogueEntry | undefined {
  const entry = catalogue.entries.find((candidate) => candidate.type === type);
  if (!entry) return undefined;
  if (entry.alias_of) {
    return catalogue.entries.find((candidate) => candidate.type === entry.alias_of) ?? entry;
  }
  return entry;
}

/**
 * The connector catalogue (`connectors.v1.json`): the seeded top-100
 * integration definitions. This mirrors the ConnectorRecord shape in
 * @mindlynx/metis-nodes structurally, so the seeder registers each record
 * directly; kept here as data so metis-catalogue carries no node
 * dependency.
 */
/** A typed input an operation receives; mirrors metis-nodes structurally. */
export interface ConnectorCatalogueOperationParameter {
  key: string;
  label: string;
  required?: boolean;
  type?: 'string' | 'text' | 'email' | 'number' | 'boolean';
  placeholder?: string;
  description?: string;
}

/** A typed output an operation gives back; mirrors metis-nodes structurally. */
export interface ConnectorCatalogueOperationOutput {
  key: string;
  label?: string;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
}

export interface ConnectorCatalogueOperation {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  description?: string;
  parameters?: ConnectorCatalogueOperationParameter[];
  outputs?: ConnectorCatalogueOperationOutput[];
  wireStatus: 'verified' | 'derived' | 'unverified';
}

/**
 * An authenticated request the health tester uses to probe a connection,
 * INSTEAD of a bare GET of the base URL. Set this when a connector's root URL
 * does not validate the key (e.g. Resend's root returns 200 for any bearer, so
 * a bad key would falsely read green). Point it at an endpoint that does check
 * auth; `body` is sent so a required-field 4xx (not 401/403) still proves the
 * key works without performing a real action.
 */
export interface ConnectorHealthCheck {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

export interface ConnectorCatalogueRecord {
  connectorId: string;
  name: string;
  baseUrl: string;
  authScheme: 'bearer' | 'header' | 'basic' | 'none' | 'database';
  authHeaderName?: string;
  headers?: Record<string, string>;
  tier: 'open' | 'premium';
  category?: string;
  priority?: 'P0' | 'P1' | 'P2';
  operations?: ConnectorCatalogueOperation[];
  events?: { name: string; kind: 'webhook' | 'poll'; pollConfig?: { cursorField?: string } }[];
  provenance?: { source: string; licence: string };
  /** Custom auth probe for the health tester (see ConnectorHealthCheck). */
  healthCheck?: ConnectorHealthCheck;
  /** The credential fields this connector's connection needs (see connector-credentials). */
  credentials?: CredentialFieldDef[];
  /** A brand hue for the connector's mark in the UI. */
  brandColor?: string;
}

export interface ConnectorCatalogue {
  schemaVersion: string;
  generated: string;
  count: number;
  connectors: ConnectorCatalogueRecord[];
}

let connectorsCached: ConnectorCatalogue | undefined;

/** Load the seeded connector catalogue, cached and path-overridable. */
export function getConnectorCatalogue(options: GetCatalogueOptions = {}): ConnectorCatalogue {
  if (connectorsCached && !options.reload) return connectorsCached;
  const path =
    options.path ??
    process.env.CONNECTOR_CATALOGUE_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), 'connectors.v1.json');
  connectorsCached = JSON.parse(readFileSync(path, 'utf8')) as ConnectorCatalogue;
  return connectorsCached;
}

/**
 * Every connector offered to the UI: the frozen top-100 SaaS catalogue plus the
 * extra wired HTTP connectors and the infra/database connectors (both live
 * outside the length-locked connectors.v1.json). This is what the connector
 * picker and connections list consume; getConnectorCatalogue stays the
 * top-100 alone.
 */
export function listAllConnectors(): ConnectorCatalogueRecord[] {
  return [...getConnectorCatalogue().connectors, ...EXTRA_CONNECTORS, ...DATABASE_CONNECTORS].map((c) => ({
    ...c,
    // Attach the credential schema + brand mark the UI renders (a connector is
    // rarely a single key: Stripe carries three fields, a database five).
    credentials: c.credentials ?? credentialSchemaFor(c.connectorId, c.authScheme),
    brandColor: c.brandColor ?? brandColorFor(c.connectorId),
    healthCheck: c.healthCheck ?? healthCheckFor(c.connectorId),
  }));
}
