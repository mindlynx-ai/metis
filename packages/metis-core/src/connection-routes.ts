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
 * Connection routes: a connection is a NAMED INSTANCE of a connector type
 * (name + type + its own auth), so a node can call it. A connector type can
 * have several connections. Material is write-only (stored encrypted, never
 * read back or logged); list and health return metadata only. Reads are open;
 * writes require edit.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HELIX_ACCOUNT_CONNECTOR_ID,
  type ConnectionTester,
  type ConnectorCredentialStore,
  type Session,
} from '@mindlynx/metis-ports';
import { listAllConnectors, credentialSchemaFor } from '@mindlynx/metis-catalogue';
import { requireAction } from './auth-gate.js';

const createBody = z.object({
  name: z.string().min(1).max(120),
  connectorId: z.string().min(1),
  connectionType: z.string().optional(),
  baseUrl: z.string().optional(),
  authScheme: z.string().optional(),
  material: z.record(z.string(), z.string()),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    material: z.record(z.string(), z.string()).optional(),
  })
  .refine((body) => body.name !== undefined || body.material !== undefined, {
    message: 'name or material required',
  });

const testBody = z.object({
  connectorId: z.string().optional(),
  authScheme: z.string().optional(),
  baseUrl: z.string().optional(),
  authHeaderName: z.string().optional(),
  material: z.record(z.string(), z.string()),
});

export function registerConnectionRoutes(
  app: FastifyInstance,
  credentials: ConnectorCredentialStore,
  tester?: ConnectionTester,
): void {
  // The tenant's connections (metadata only, never material).
  app.get('/api/connections', async (request, reply) => {
    const session = request.session as Session;
    const connections = await credentials.listConnections(session.tenantId);
    return reply.send({ connections });
  });

  // One connection, with its NON-SECRET credential values for the edit form
  // (host, port, publishable key, ...). Secret-flagged fields are NEVER
  // returned - they stay write-only.
  app.get('/api/connections/:id', async (request, reply) => {
    const session = request.session as Session;
    const { id } = request.params as { id: string };
    const connection = (await credentials.listConnections(session.tenantId)).find(
      (c) => c.connectionId === id,
    );
    if (!connection) return reply.code(404).send({ error: 'connection not found' });
    const schema = credentialSchemaFor(connection.connectorId, connection.authScheme);
    const secretKeys = new Set(schema.filter((f) => f.secret).map((f) => f.key));
    const material = await credentials.resolveConnectorCredentials(session.tenantId, id);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(material)) {
      if (!secretKeys.has(key)) values[key] = value;
    }
    return reply.send({ connection, values });
  });

  // Create a named connection for a connector type.
  app.post('/api/connections', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'name, connectorId and material are required' });
    }
    const record = await credentials.createConnection(session.tenantId, parsed.data);
    return reply.code(201).send(record);
  });

  // Rename a connection or replace its material.
  app.patch('/api/connections/:id', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const { id } = request.params as { id: string };
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'name or material required' });
    await credentials.updateConnection(session.tenantId, id, parsed.data);
    return reply.code(204).send();
  });

  // Delete a connection.
  app.delete('/api/connections/:id', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const { id } = request.params as { id: string };
    await credentials.deleteConnection(session.tenantId, id);
    return reply.code(204).send();
  });

  // Health: test a connection against its service so the list can show what is
  // not working. Resolves the material server-side (never returned) and the
  // connection's connector TYPE for the scheme/baseUrl, then calls the tester.
  if (tester) {
    app.post('/api/connections/:id/test', async (request, reply) => {
      const session = request.session as Session;
      const { id } = request.params as { id: string };
      const connection = (await credentials.listConnections(session.tenantId)).find(
        (c) => c.connectionId === id,
      );
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      // Prefer the connection's own scheme/baseUrl (generic connections carry
      // them); fall back to its connector TYPE from the catalogue.
      const connector = listAllConnectors().find((c) => c.connectorId === connection.connectorId);
      const material = await credentials.resolveConnectorCredentials(session.tenantId, id);
      // The reserved Helix-account link has no HTTP endpoint the generic
      // tester can probe (it reported "no base URL" as an error). Its health
      // here is "the vault still holds the link"; token freshness is the
      // uplift bearer's job.
      if (connection.connectorId === HELIX_ACCOUNT_CONNECTOR_ID) {
        const linked = Object.keys(material).length > 0;
        return reply.send({
          status: linked ? 'ok' : 'auth_failed',
          ok: linked,
          message: linked ? 'Helix account linked' : 'no Helix account link in the vault',
          checkedAt: new Date().toISOString(),
        });
      }
      const health = await tester.testConnection({
        connectorId: connection.connectorId,
        authScheme: connection.authScheme ?? connector?.authScheme ?? 'none',
        baseUrl: connection.baseUrl ?? connector?.baseUrl,
        authHeaderName: connector?.authHeaderName,
        healthCheck: connector?.healthCheck,
        material,
      });
      return reply.send(health);
    });

    // Test raw material WITHOUT saving, so the create-connection modal can
    // verify credentials before committing them. When a connectorId (a service)
    // is given, its scheme/baseUrl fill in the gaps.
    app.post('/api/connections/test', async (_request, reply) => {
      const parsed = testBody.safeParse(_request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'material is required' });
      const body = parsed.data;
      const connector = body.connectorId
        ? listAllConnectors().find((c) => c.connectorId === body.connectorId)
        : undefined;
      const health = await tester.testConnection({
        connectorId: body.connectorId ?? '',
        authScheme: body.authScheme ?? connector?.authScheme ?? 'none',
        baseUrl: body.baseUrl ?? connector?.baseUrl,
        authHeaderName: body.authHeaderName ?? connector?.authHeaderName,
        healthCheck: connector?.healthCheck,
        material: body.material,
      });
      return reply.send(health);
    });
  }
}
