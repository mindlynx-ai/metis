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
 * Data-resource routes: the live catalogue behind the Data node's visual table
 * builder. A connection's engine (its connector type - postgres today) resolves
 * to a DataSource adapter, and we list its tables / describe a table's columns
 * so the inspector offers real tables instead of a typed name. Material is
 * resolved server-side and never returned. An engine with no open adapter
 * (athena/snowflake, which live in Helix) returns `locked`, not an error, so the
 * inspector degrades to a typed table name.
 */
import type { FastifyInstance } from 'fastify';
import type {
  ConnectorCredentialStore,
  DataSourceRegistry,
  Session,
} from '@mindlynx/metis-ports';

/** The connection's engine is its connector type (a database connection's
 *  connectorId IS the engine: postgres, athena, snowflake, ...). */
async function resolveEngine(
  credentials: ConnectorCredentialStore,
  tenantId: string,
  connectionId: string,
): Promise<{ engine: string; material: Record<string, string> } | undefined> {
  const connection = (await credentials.listConnections(tenantId)).find(
    (c) => c.connectionId === connectionId,
  );
  if (!connection) return undefined;
  const material = await credentials.resolveConnectorCredentials(tenantId, connectionId);
  return { engine: connection.connectorId, material };
}

export function registerDataResourceRoutes(
  app: FastifyInstance,
  credentials: ConnectorCredentialStore,
  dataSources: DataSourceRegistry,
): void {
  app.get('/api/data/tables', async (request, reply) => {
    const session = request.session as Session;
    const connectionId = String((request.query as { connectionId?: string }).connectionId ?? '');
    if (!connectionId) return reply.code(400).send({ error: 'connectionId is required' });

    const resolved = await resolveEngine(credentials, session.tenantId, connectionId);
    if (!resolved) return reply.code(404).send({ error: 'unknown connection' });

    const source = dataSources.get(resolved.engine);
    // An engine we do not carry in the open build (athena/snowflake): the
    // inspector shows the upgrade note and falls back to a typed table name.
    if (!source) return reply.send({ engine: resolved.engine, locked: true, tables: [] });

    try {
      const tables = await source.listTables({
        key: `${session.tenantId}/${connectionId}`,
        material: resolved.material,
      });
      return reply.send({ engine: resolved.engine, tables });
    } catch (error) {
      // A dead/unreachable database is not a 500 for the whole editor: report
      // it so the inspector can offer a typed name instead.
      return reply.send({
        engine: resolved.engine,
        tables: [],
        error: error instanceof Error ? error.message : 'could not list tables',
      });
    }
  });

  app.post('/api/data/validate', async (request, reply) => {
    const session = request.session as Session;
    const body = (request.body ?? {}) as { connectionId?: string; query?: string; params?: unknown[] };
    if (!body.connectionId || !body.query) {
      return reply.code(400).send({ error: 'connectionId and query are required' });
    }
    const resolved = await resolveEngine(credentials, session.tenantId, body.connectionId);
    if (!resolved) return reply.code(404).send({ error: 'unknown connection' });

    const source = dataSources.get(resolved.engine);
    if (!source?.describeQuery) {
      return reply.send({ engine: resolved.engine, locked: true, valid: false });
    }

    try {
      const columns = await source.describeQuery(
        { key: `${session.tenantId}/${body.connectionId}`, material: resolved.material },
        body.query,
        { params: body.params },
      );
      // Valid: the query planned cleanly. Its columns become the node's outputs.
      return reply.send({ engine: resolved.engine, valid: true, columns });
    } catch (error) {
      // Invalid: a bad join/column/type. Surface the database's own message.
      return reply.send({
        engine: resolved.engine,
        valid: false,
        error: error instanceof Error ? error.message : 'invalid query',
      });
    }
  });

  app.get('/api/data/tables/:table/columns', async (request, reply) => {
    const session = request.session as Session;
    const { table } = request.params as { table: string };
    const connectionId = String((request.query as { connectionId?: string }).connectionId ?? '');
    if (!connectionId) return reply.code(400).send({ error: 'connectionId is required' });

    const resolved = await resolveEngine(credentials, session.tenantId, connectionId);
    if (!resolved) return reply.code(404).send({ error: 'unknown connection' });

    const source = dataSources.get(resolved.engine);
    if (!source) return reply.send({ engine: resolved.engine, locked: true, columns: [] });

    try {
      const columns = await source.describeTable(
        { key: `${session.tenantId}/${connectionId}`, material: resolved.material },
        table,
      );
      return reply.send({ engine: resolved.engine, columns });
    } catch (error) {
      return reply.send({
        engine: resolved.engine,
        columns: [],
        error: error instanceof Error ? error.message : 'could not describe table',
      });
    }
  });
}
