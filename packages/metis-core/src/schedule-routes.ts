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
 * Schedule routes for Operate: list every Temporal Schedule with its state,
 * and pause/resume one. Reads are open; the levers require edit. The port is
 * structural (see CoreDependencies.schedules) so core never imports the
 * orchestrator.
 */
import type { FastifyInstance } from 'fastify';
import type { Session } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import { requireAction } from './auth-gate.js';

export interface SchedulesLike {
  describeAll(tenantId: string): Promise<
    {
      scheduleId: string;
      workflowId: string;
      paused: boolean;
      cron?: string;
      nextRun?: string;
      nextRuns?: string[];
    }[]
  >;
  pause(tenantId: string, workflowId: string, note?: string): Promise<void>;
  unpause(tenantId: string, workflowId: string, note?: string): Promise<void>;
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  schedules: SchedulesLike,
  store?: WorkflowStore,
): void {
  app.get('/api/operate/schedules', async (request, reply) => {
    const session = request.session as Session;
    const items = await schedules.describeAll(session.tenantId);
    // Identity: the workflow NAME, not just its id (same rule as the board).
    const named = await Promise.all(
      items.map(async (item) => {
        const latest = store ? await store.getLatestVersion(session.tenantId, item.workflowId) : undefined;
        return { ...item, workflowName: latest?.name ?? (item as { workflowName?: string }).workflowName };
      }),
    );
    return reply.send({ items: named });
  });

  app.post(
    '/api/schedules/:workflowId/pause',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const session = request.session as Session;
      const { workflowId } = request.params as { workflowId: string };
      await schedules.pause(session.tenantId, workflowId);
      return reply.code(202).send({ workflowId, paused: true });
    },
  );

  app.post(
    '/api/schedules/:workflowId/unpause',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const session = request.session as Session;
      const { workflowId } = request.params as { workflowId: string };
      await schedules.unpause(session.tenantId, workflowId);
      return reply.code(202).send({ workflowId, paused: false });
    },
  );
}
