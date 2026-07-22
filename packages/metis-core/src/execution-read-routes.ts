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
 * Read-only execution routes: run history and per-node logs
 * straight from the gateway, so the editor's viewer works with no
 * external service. Writes and lifecycle stay with the
 * orchestrator surface.
 */
import type { FastifyInstance } from 'fastify';
import type { Session } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';

export function registerExecutionReadRoutes(app: FastifyInstance, store: WorkflowStore): void {
  app.get('/api/executions', async (request, reply) => {
    const session = request.session as Session;
    const query = request.query as { workflowId?: string; status?: string; limit?: string; cursor?: string };
    const page = await store.listExecutions(session.tenantId, {
      workflowId: query.workflowId,
      status: query.status,
      limit: Math.min(Number(query.limit ?? 25), 100),
      cursor: query.cursor,
    });
    return reply.send(page);
  });

  app.get('/api/executions/:id', async (request, reply) => {
    const session = request.session as Session;
    const { id } = request.params as { id: string };
    const execution = await store.getExecution(session.tenantId, id);
    if (!execution) return reply.code(404).send({ error: 'execution not found' });
    return reply.send(execution);
  });
}
