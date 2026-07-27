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
 * Reading the audit trail. Newest first, narrowable by actor, entity or
 * action: "who cancelled that run", "everything Ada did", "every workflow
 * published this week". Writing is not exposed - entries come from the
 * actions themselves, never from a caller.
 */
import type { FastifyInstance } from 'fastify';
import type { AuditStore } from '@mindlynx/metis-data-gateway';
import type { Session } from '@mindlynx/metis-ports';
import { requireAction } from './auth-gate.js';

export function registerAuditRoutes(app: FastifyInstance, audit: AuditStore): void {
  app.get('/api/audit', { preHandler: requireAction('admin') }, async (request, reply) => {
    const session = request.session as Session;
    const query = request.query as {
      actor?: string;
      entityId?: string;
      action?: string;
      limit?: string;
    };
    const items = await audit.list(session.tenantId, {
      actor: query.actor,
      entityId: query.entityId,
      action: query.action,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return reply.send({ items, count: items.length });
  });
}
