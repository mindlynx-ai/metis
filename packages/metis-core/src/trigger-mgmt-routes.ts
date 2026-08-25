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
import type { Session } from '@mindlynx/metis-ports';
import type { AuditStore } from '@mindlynx/metis-data-gateway';
import { requireAction } from './auth-gate.js';
import { webhookHint, webhookUrl } from './webhook-address.js';

export interface TriggersPort {
  list(): Promise<Record<string, unknown>[]>;
  create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(triggerId: string): Promise<void>;
  setSecret(triggerId: string, secret: string): Promise<boolean>;
}

const rotateSecretBody = z.object({ secret: z.string().min(1) });

const createTriggerBody = z.object({
  workflowId: z.string().min(1),
  kind: z.enum(['webhook', 'schedule', 'poll']),
  // schedule
  cron: z.string().optional(),
  // webhook
  verification: z.enum(['github', 'svix', 'hmac', 'none']).optional(),
  secret: z.string().optional(),
  // poll / connector-bound
  connectorId: z.string().optional(),
  event: z.string().optional(),
  operation: z.string().optional(),
  itemsPath: z.string().optional(),
  cursorField: z.string().optional(),
  pollParams: z.record(z.string(), z.unknown()).optional(),
});

/**
 * What a kind needs before it can do anything, named in the message.
 *
 * The CLI already refused all of these (metis-cli triggers.ts) and the HTTP API
 * the editor uses refused only the missing cron, so a poll trigger could be
 * created with no cursor field: connector-poller then treats every item as
 * fresh on every 30-second tick, and 20 items becomes 57,600 runs a day.
 * Omitting the connector or the operation is the mirror case, and quieter: the
 * poll fetcher returns nothing without them, so the trigger sits in the list
 * looking armed and can never fire.
 */
function missingRequirement(input: z.infer<typeof createTriggerBody>): string | undefined {
  if (input.kind === 'schedule' && !input.cron) {
    return 'a schedule trigger needs a cron expression';
  }
  if (input.kind !== 'poll') return undefined;
  if (!input.connectorId) return 'a poll trigger needs a connectorId: there is nothing to poll without one';
  if (!input.operation) {
    return 'a poll trigger needs an operation: without one the poll fetches nothing and the trigger can never fire';
  }
  if (!input.cursorField) {
    return 'a poll trigger needs a cursorField: without it every item looks new on every tick and the whole result set re-runs every 30 seconds';
  }
  return undefined;
}

export function registerTriggerMgmtRoutes(
  app: FastifyInstance,
  triggers: TriggersPort,
  audit?: AuditStore,
): void {
  // A trigger is what makes a published workflow fire on its own, and none of
  // these routes touch the definition, so the workflow's own history shows
  // nothing: arming one, changing its lock and removing it are only ever
  // recorded here.
  const trail = (
    session: Session,
    action: string,
    triggerId: string,
    detail?: Record<string, unknown>,
  ) =>
    audit?.record({
      tenantId: session.tenantId,
      actor: session.userId,
      action,
      entityType: 'trigger',
      entityId: triggerId,
      outcome: 'ok',
      detail,
    });

  // Everything about a trigger EXCEPT the shared secret a webhook one carries.
  // The stored row is returned as-is otherwise: which workflow fires, how, and
  // whether it is armed is the whole point of the list. The secret is not part
  // of that, and nothing needs it read back - rotation takes a new one and the
  // trail below records that it changed and nothing else - so the read simply
  // does not carry it. The guard matches its siblings; it is the projection
  // that makes this safe, since a secret handed to any caller is a secret out.
  app.get('/api/triggers', { preHandler: requireAction('edit') }, async (_request, reply) => {
    const items = (await triggers.list()).map((record) => {
      const shown = { ...record };
      delete shown.secret;
      return shown;
    });
    return reply.send({ items });
  });

  app.post('/api/triggers', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const parsed = createTriggerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const missing = missingRequirement(parsed.data);
    if (missing) return reply.code(400).send({ error: missing });
    try {
      const record = await triggers.create(parsed.data);
      // Disarming a workflow was trailed and arming one was not, which is
      // worse than trailing neither: the trail read as though the nightly run
      // had always been off. Never the secret a webhook trigger may carry -
      // which workflow now fires, and how, is the whole of the record.
      await trail(session, 'trigger.created', String(record.triggerId), {
        workflowId: parsed.data.workflowId,
        kind: parsed.data.kind,
      });
      // The full URL, and the truth about who can reach it. See
      // webhook-address.ts: a bare path armed a trigger nobody outside this
      // machine could ever call, and said nothing about it.
      const origin = `${request.protocol}://${request.headers.host ?? 'localhost'}`;
      const HINTS: Record<string, string> = {
        webhook: webhookHint(origin, String(record.triggerId)),
        schedule: 'live in Temporal now',
        poll: 'polls on the next runtime cycle',
      };
      const kind = String(record.kind);
      return reply.code(201).send({
        ...record,
        ...(kind === 'webhook' ? { url: webhookUrl(origin, String(record.triggerId)) } : {}),
        hint: HINTS[kind],
      });
    } catch (error) {
      // Most likely: a schedule on an unpublished workflow. Surface it plainly.
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Rotate a webhook's shared secret in place, so the URL survives. Needed to
  // replace a leaked secret, and the only workable order when the sender mints
  // the secret itself: the endpoint must exist before there is one to store.
  app.put('/api/triggers/:triggerId/secret', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const parsed = rotateSecretBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'a non-empty secret is required' });
    }
    const { triggerId } = request.params as { triggerId: string };
    const rotated = await triggers.setSecret(triggerId, parsed.data.secret);
    if (!rotated) return reply.code(404).send({ error: 'unknown trigger' });
    // THAT the lock changed, and nothing whatsoever about it: not the secret,
    // not its length, not a prefix. This route exists to replace a leaked
    // secret, so an entry that narrowed the new one would work against the
    // reason it was called. No detail at all is the only safe amount of it.
    await trail(session, 'trigger.secretRotated', triggerId);
    // The secret itself is never echoed back.
    return reply.send({ triggerId, rotated: true });
  });

  app.delete('/api/triggers/:triggerId', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const { triggerId } = request.params as { triggerId: string };
    await triggers.remove(triggerId);
    // Removing a trigger stops a published workflow firing and takes the
    // trigger row with it. Without this line nothing says it ever existed, so
    // "why did the nightly run stop" has no answer.
    await trail(session, 'trigger.deleted', triggerId);
    return reply.code(204).send();
  });
}
