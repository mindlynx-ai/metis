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
 * The postgres node, ported from the origin postgresNode.ts:
 * parameterised queries only, a small pg.Pool per connector (max 5
 * clients, 5 minute idle timeout), credentials resolved exclusively at
 * the CredentialPort boundary and never echoed into results or logs.
 */
import { poolFor } from './postgres-pool.js';
import { stateEnvelope, type CredentialPort, type NodeHandler } from '@mindlynx/metis-ports';
import { buildQuery, type PgBuilderConfig } from './postgres-query.js';

// Two modes: a raw parameterised `query` + `params`, or the visual query-
// builder (operation + tables/where/orderBy...), matching the Helix postgres
// node so a node authored in either engine runs unchanged.
interface PostgresNodeConfig extends PgBuilderConfig {
  connectorId?: string;
  /** The chosen connection instance id (material is resolved from this). */
  connectionId?: string;
  query?: string;
  params?: unknown[];
}

export function createPostgresNodeHandler(credentials: CredentialPort): NodeHandler {
  return async (ctx) => {
    const config = ctx.nodeRef.config as PostgresNodeConfig;
    // The node references a connection instance by id; falls back to the
    // connector type id so a single unnamed connection still resolves.
    const connectionId = String(config.connectionId ?? config.connectorId ?? '');
    if (!connectionId) {
      return { status: 400, message: 'postgres node requires a connection' };
    }

    // Raw mode wins when a query string is given; otherwise build from the
    // visual builder config (operation + tables/where/...).
    let built: { query: string; params: unknown[] };
    if (config.query && config.query.trim() !== '') {
      built = { query: config.query, params: (config.params ?? []) as unknown[] };
    } else if (config.operation) {
      try {
        built = buildQuery(config);
      } catch (error) {
        return { status: 400, message: error instanceof Error ? error.message : String(error) };
      }
    } else {
      return { status: 400, message: 'postgres node requires a query or an operation' };
    }

    let material: Record<string, string>;
    try {
      material = await credentials.resolveConnectorCredentials(ctx.tenantId, connectionId);
    } catch {
      // The resolution error may carry secret context; report only the
      // connection id.
      return {
        status: 500,
        message: `could not resolve credentials for connection "${connectionId}"`,
        nodeData: { code: 'credentials' },
      };
    }
    try {
      const pool = poolFor(`${ctx.tenantId}/${connectionId}`, material);
      const result = await pool.query(built.query, built.params);
      const output = { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
      return { status: 200, message: 'ok', nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, output) };
    } catch (error) {
      return { status: 500, message: error instanceof Error ? error.message : String(error) };
    }
  };
}
