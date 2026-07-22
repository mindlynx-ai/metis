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
 * Trigger management: bind a webhook, schedule or poll trigger to a workflow
 * (what makes a published workflow fire on its own), list them, remove them.
 * The port is structural (CoreDependencies.triggers) so core never imports the
 * orchestrator; the collapsed runtime supplies an implementation that also
 * provisions the Temporal Schedule for a schedule trigger.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAction } from './auth-gate.js';

export interface TriggersPort {
  list(): Promise<Record<string, unknown>[]>;
  create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(triggerId: string): Promise<void>;
}

const createTriggerBody = z.object({
  workflowId: z.string().min(1),
  kind: z.enum(['webhook', 'schedule', 'poll']),
  // schedule
  cron: z.string().optional(),
  // webhook
  verification: z.enum(['github', 'hmac', 'none']).optional(),
  secret: z.string().optional(),
  // poll / connector-bound
  connectorId: z.string().optional(),
  event: z.string().optional(),
  operation: z.string().optional(),
  itemsPath: z.string().optional(),
  cursorField: z.string().optional(),
  pollParams: z.record(z.string(), z.unknown()).optional(),
});

export function registerTriggerMgmtRoutes(app: FastifyInstance, triggers: TriggersPort): void {
  app.get('/api/triggers', async (_request, reply) => {
    return reply.send({ items: await triggers.list() });
  });

  app.post('/api/triggers', { preHandler: requireAction('edit') }, async (request, reply) => {
    const parsed = createTriggerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    if (parsed.data.kind === 'schedule' && !parsed.data.cron) {
      return reply.code(400).send({ error: 'a schedule trigger needs a cron expression' });
    }
    try {
      const record = await triggers.create(parsed.data);
      const HINTS: Record<string, string> = {
        webhook: `POST to /hooks/${record.triggerId}`,
        schedule: 'live in Temporal now',
        poll: 'polls on the next runtime cycle',
      };
      return reply.code(201).send({ ...record, hint: HINTS[String(record.kind)] });
    } catch (error) {
      // Most likely: a schedule on an unpublished workflow. Surface it plainly.
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/triggers/:triggerId', { preHandler: requireAction('edit') }, async (request, reply) => {
    const { triggerId } = request.params as { triggerId: string };
    await triggers.remove(triggerId);
    return reply.code(204).send();
  });
}
