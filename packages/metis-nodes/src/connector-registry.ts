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
 * The connector registry: operator-registered records that
 * drive the generic connector node. A record names the base URL and
 * auth scheme; the secret material itself lives behind the
 * CredentialPort under the same connector id.
 *
 * The record is the "connector as data" unit: as
 * well as the base URL and auth it carries a catalogue of named
 * `operations` (method + path template) and trigger `events`, plus the
 * open/premium `tier` marker. One generic node dispatches every
 * connector by operation name - no code module per app.
 */
import type { TableDefinition } from '@mindlynx/metis-ports';
import type { DataGateway } from '@mindlynx/metis-data-gateway';

export const CONNECTORS_TABLE: TableDefinition = {
  name: 'connectors',
  partitionAttribute: 'PK',
  sortAttribute: 'SK',
};

export function registerConnectorTable(gateway: DataGateway): void {
  gateway.registerDefinition(CONNECTORS_TABLE);
}

export type ConnectorAuthScheme = 'bearer' | 'header' | 'basic' | 'none';
export type ConnectorTier = 'open' | 'premium';
export type ConnectorPriority = 'P0' | 'P1' | 'P2';
export type ConnectorHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/**
 * How much of the operation's wire detail we have confirmed. "verified"
 * operations are hand-authored from public API docs and exercised
 * end-to-end; "derived" come from a machine source (Activepieces) with
 * best-effort method+path; "unverified" carry a name only and are not
 * yet runnable.
 */
export type ConnectorWireStatus = 'verified' | 'derived' | 'unverified';

export const CONNECTOR_HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * One typed input an operation receives - the "what you receive" half of a node
 * type. It becomes a path token, query value, or JSON body field (by the
 * operation's method), and drives a labelled field in the inspector instead of a
 * blank key/value editor. `key` is the wire name sent to the connector.
 */
export interface OperationParameter {
  key: string;
  label: string;
  required?: boolean;
  /** Inspector widget hint; defaults to a single-line string. */
  type?: 'string' | 'text' | 'email' | 'number' | 'boolean';
  placeholder?: string;
  description?: string;
}

/**
 * One field an operation gives back - the "what you give" half of a node type.
 * It becomes a `{{node-<id>.data.<key>}}` variable downstream steps can insert,
 * and a chip in the node's outputs panel. `key` is the field name under the
 * node's `data` (e.g. Resend's send returns `data.id`).
 */
export interface OperationOutput {
  key: string;
  label?: string;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
}

export interface ConnectorOperation {
  /** Stable operation name the node dispatches by, e.g. "sendMessage". */
  name: string;
  method: ConnectorHttpMethod;
  /** Path relative to baseUrl, with {token} placeholders, e.g. "/deals/{dealId}". */
  pathTemplate: string;
  description?: string;
  /** The typed inputs this operation receives (labelled fields in the inspector). */
  parameters?: OperationParameter[];
  /** The typed outputs this operation gives back (downstream variables). */
  outputs?: OperationOutput[];
  wireStatus: ConnectorWireStatus;
}

export interface ConnectorEvent {
  name: string;
  kind: 'webhook' | 'poll';
  pollConfig?: { cursorField?: string };
}

export interface ConnectorProvenance {
  /** Source ecosystem the definition was derived from (n8n, activepieces, catalogue). */
  source: string;
  /** Licence under which that source is used. */
  licence: string;
}

export interface ConnectorRecord {
  connectorId: string;
  name: string;
  baseUrl: string;
  authScheme: ConnectorAuthScheme;
  /** Header name for the header scheme (for example x-api-key). */
  authHeaderName?: string;
  /** Static extra headers sent on every call. */
  headers?: Record<string, string>;
  /** Open ships every definition; premium is gated by the Helix pack. Absent = open. */
  tier?: ConnectorTier;
  category?: string;
  priority?: ConnectorPriority;
  /** Named operations the generic connector node can dispatch. */
  operations?: ConnectorOperation[];
  /** Trigger events (webhook or poll) the connector can raise. */
  events?: ConnectorEvent[];
  provenance?: ConnectorProvenance;
}

const pk = (tenantId: string) => `CONN#${tenantId}`;

const SCHEME_CHAR = /[a-z0-9+.-]/i;

/**
 * True if a path carries a URL scheme (e.g. "http:", "javascript:") or
 * is protocol-relative ("//host"). A linear scan - no backtracking regex
 * - so it is safe on adversarial input. Relative API paths return false.
 */
export function hasUrlScheme(path: string): boolean {
  if (path.startsWith('//')) return true;
  const colon = path.indexOf(':');
  if (colon <= 0) return false;
  const slash = path.indexOf('/');
  if (slash !== -1 && slash < colon) return false;
  if (!/[a-z]/i.test(path[0])) return false;
  for (let i = 1; i < colon; i += 1) {
    if (!SCHEME_CHAR.test(path[i])) return false;
  }
  return true;
}

/** The effective tier, treating a record without an explicit tier as open. */
export function connectorTier(record: ConnectorRecord): ConnectorTier {
  return record.tier ?? 'open';
}

/** Resolve a named operation on a record (case-sensitive). */
export function findOperation(
  record: ConnectorRecord,
  operation: string,
): ConnectorOperation | undefined {
  return record.operations?.find((candidate) => candidate.name === operation);
}

function operationProblems(operation: ConnectorOperation, index: number): string[] {
  const problems: string[] = [];
  const label = operation.name || `operations[${index}]`;
  if (!operation.name || operation.name.trim() === '') {
    problems.push(`operations[${index}]: name is required`);
  }
  if (!CONNECTOR_HTTP_METHODS.has(operation.method)) {
    problems.push(`${label}: method "${operation.method}" is not a valid HTTP method`);
  }
  if (!operation.pathTemplate || operation.pathTemplate.trim() === '') {
    problems.push(`${label}: pathTemplate is required`);
  } else if (hasUrlScheme(operation.pathTemplate)) {
    problems.push(`${label}: pathTemplate must be relative to the connector base URL`);
  }
  if (!['verified', 'derived', 'unverified'].includes(operation.wireStatus)) {
    problems.push(`${label}: wireStatus "${operation.wireStatus}" is invalid`);
  }
  return problems;
}

/** Structural problems with a record; empty array means it is valid to register. */
export function validateConnectorRecord(record: ConnectorRecord): string[] {
  const problems: string[] = [];
  if (!record.connectorId || record.connectorId.trim() === '') {
    problems.push('connectorId is required');
  }
  if (!record.baseUrl || record.baseUrl.trim() === '') {
    problems.push(`${record.connectorId || '(unnamed)'}: baseUrl is required`);
  } else {
    try {
      const url = new URL(record.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        problems.push(`${record.connectorId}: baseUrl must be http or https`);
      }
    } catch {
      problems.push(`${record.connectorId}: baseUrl "${record.baseUrl}" is not a valid URL`);
    }
  }
  if (record.tier && record.tier !== 'open' && record.tier !== 'premium') {
    problems.push(`${record.connectorId}: tier "${record.tier}" is invalid`);
  }
  const seen = new Set<string>();
  record.operations?.forEach((operation, index) => {
    if (seen.has(operation.name)) problems.push(`${record.connectorId}: duplicate operation "${operation.name}"`);
    seen.add(operation.name);
    problems.push(...operationProblems(operation, index).map((p) => `${record.connectorId}.${p}`));
  });
  return problems;
}

export class ConnectorRegistry {
  constructor(private readonly gateway: DataGateway) {}

  async register(tenantId: string, record: ConnectorRecord): Promise<void> {
    const problems = validateConnectorRecord(record);
    if (problems.length > 0) {
      throw new Error(`invalid connector record: ${problems.join('; ')}`);
    }
    await this.gateway.upsert(CONNECTORS_TABLE.name, {
      ...record,
      tier: connectorTier(record),
      PK: pk(tenantId),
      SK: record.connectorId,
      tenantId,
    });
  }

  async get(tenantId: string, connectorId: string): Promise<ConnectorRecord | undefined> {
    const item = await this.gateway.read(CONNECTORS_TABLE.name, {
      partitionKey: pk(tenantId),
      sortKey: connectorId,
    });
    return item as ConnectorRecord | undefined;
  }

  async list(tenantId: string): Promise<ConnectorRecord[]> {
    const page = await this.gateway.query({
      table: CONNECTORS_TABLE.name,
      partitionValue: pk(tenantId),
    });
    return page.items as unknown as ConnectorRecord[];
  }
}
