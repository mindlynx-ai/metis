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
 * Test harness: a standalone HTTP server over the orchestrator
 * services (ExecutionPort, WorkflowStore, ScheduleService, triggers),
 * so the specs in this directory can drive them end-to-end against a
 * real Temporal test environment. The shipped runtime composes these
 * services into metis-cli's control server instead; nothing outside
 * these tests serves this surface.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ExecutionPort, IdentityPort, Session } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import { validateDefinition, type WorkflowDefinition } from '@mindlynx/metis-engine';
import { getCatalogue } from '@mindlynx/metis-catalogue';
import type { ScheduleService } from '../schedules.js';

export interface ServerDependencies {
  executions: ExecutionPort;
  store: WorkflowStore;
  identity: IdentityPort;
  /** The single tenant webhooks and schedules act for. */
  tenantId?: string;
  schedules?: ScheduleService;
}

const startBody = z.object({
  workflowId: z.string().min(1),
  definition: z
    .object({ nodes: z.array(z.record(z.unknown())), edges: z.array(z.record(z.unknown())) })
    .optional(),
  input: z.record(z.unknown()).optional(),
  type: z.enum(['workflow', 'api']).default('workflow'),
});

const signalBody = z.object({
  signalType: z.string().min(1),
  signalParams: z.unknown().optional(),
});

const cancelBody = z.object({ reason: z.string().optional() });

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

function verifyWebhookSignature(rawBody: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

interface WebhookConfigNode {
  id: string;
  type: string;
  config?: { webhookId?: string; secret?: string };
}

async function registerWebhookRoutes(app: FastifyInstance, deps: ServerDependencies): Promise<void> {
  const tenantId = deps.tenantId ?? 'default';
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/api/webhooks/:webhookId', async (request, reply) => {
    const { webhookId } = request.params as { webhookId: string };
    const rawBody = typeof request.body === 'string' ? request.body : '';

    const page = await deps.store.listWorkflows(tenantId, { status: 'published', limit: 100 });
    let match: { workflowId: string; node: WebhookConfigNode; definition: WorkflowDefinition } | undefined;
    for (const item of page.items) {
      const definition = item.definition as unknown as WorkflowDefinition;
      const node = definition.nodes.find(
        (candidate) =>
          candidate.type.toLowerCase() === 'webhookconfig' &&
          (candidate.config as { webhookId?: string } | undefined)?.webhookId === webhookId,
      ) as WebhookConfigNode | undefined;
      if (node) {
        match = { workflowId: item.workflowId, node, definition };
        break;
      }
    }
    if (!match) return reply.code(404).send({ error: 'webhook not found' });

    const secret = match.node.config?.secret ?? '';
    const signature = String(request.headers['x-metis-signature'] ?? '');
    if (!secret || !verifyWebhookSignature(rawBody, secret, signature)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    let payload: Record<string, unknown> = {};
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return reply.code(400).send({ error: 'body must be JSON' });
      }
    }

    const executionId = `exec_${randomUUID()}`;
    await deps.executions.start({
      tenantId,
      workflowId: match.workflowId,
      executionId,
      workflowType: 'helixWorkflow',
      definition: match.definition,
      input: payload,
    } as never);
    return reply.code(202).send({ executionId });
  });
}

function registerScheduleRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  const schedules = deps.schedules;
  if (!schedules) return;
  const scheduleBody = z.object({ workflowId: z.string().min(1), cron: z.string().min(1) });

  app.post('/api/triggers/schedule', async (request, reply) => {
    const session = request.session as Session;
    const parsed = scheduleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    try {
      const created = await schedules.create(
        session.tenantId,
        parsed.data.workflowId,
        parsed.data.cron,
      );
      return reply.code(201).send(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /no published version/.test(message) ? 404 : 500;
      return reply.code(code).send({ error: message });
    }
  });

  app.get('/api/triggers/schedule', async (request, reply) => {
    const session = request.session as Session;
    return reply.send({ items: await schedules.list(session.tenantId) });
  });

  app.post('/api/triggers/schedule/:workflowId/run-now', async (request, reply) => {
    const session = request.session as Session;
    const { workflowId } = request.params as { workflowId: string };
    await schedules.runNow(session.tenantId, workflowId);
    return reply.code(202).send({ ok: true });
  });

  app.delete('/api/triggers/schedule/:workflowId', async (request, reply) => {
    const session = request.session as Session;
    const { workflowId } = request.params as { workflowId: string };
    await schedules.remove(session.tenantId, workflowId);
    return reply.code(204).send();
  });
}

export function buildServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(async (webhookScope) => {
    await registerWebhookRoutes(webhookScope, deps);
  });

  app.register(async (authed) => {
    authed.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      const session = token ? await deps.identity.verify(token) : undefined;
      if (!session) {
        await reply.code(401).send({ error: 'unauthorised' });
        return reply;
      }
      request.session = session;
    });
    registerAuthedRoutes(authed, deps);
    registerScheduleRoutes(authed, deps);
  });

  return app;
}

function registerAuthedRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  app.post('/api/executions', async (request, reply) => {
    const session = request.session as Session;
    const parsed = startBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const body = parsed.data;

    let definition = body.definition as WorkflowDefinition | undefined;
    if (!definition) {
      const published = await deps.store.getLatestPublished(session.tenantId, body.workflowId);
      if (!published) {
        return reply
          .code(404)
          .send({ error: `workflow "${body.workflowId}" has no published version` });
      }
      definition = published.definition as unknown as WorkflowDefinition;
    }
    const validation = validateDefinition(definition, { kind: body.type, level: 'start' });
    if (!validation.valid) {
      return reply.code(422).send({ error: 'invalid definition', details: validation.errors });
    }

    const executionId = `exec_${randomUUID()}`;
    await deps.executions.start({
      tenantId: session.tenantId,
      workflowId: body.workflowId,
      executionId,
      workflowType: body.type === 'api' ? 'helixApiWorkflow' : 'helixWorkflow',
      definition,
      input: body.input,
    } as never);
    return reply.code(202).send({ executionId });
  });

  app.get('/api/executions', async (request, reply) => {
    const session = request.session as Session;
    const query = request.query as { workflowId?: string; status?: string; limit?: string; cursor?: string };
    const page = await deps.store.listExecutions(session.tenantId, {
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
    const execution = await deps.store.getExecution(session.tenantId, id);
    if (!execution) return reply.code(404).send({ error: 'execution not found' });
    return reply.send(execution);
  });

  app.get('/api/executions/:id/state', async (request, reply) => {
    const session = request.session as Session;
    const { id } = request.params as { id: string };
    const execution = await deps.store.getExecution(session.tenantId, id);
    if (!execution) return reply.code(404).send({ error: 'execution not found' });
    return reply.send({ status: execution.meta.status, nodeCount: execution.logs.length });
  });

  app.get('/api/executions/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const status = await deps.executions.queryStatus(id);
    return reply.send({ executionId: id, status });
  });

  app.get('/api/executions/:id/describe', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await deps.executions.describe(id));
  });

  app.post('/api/executions/:id/signal', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = signalBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    await deps.executions.signal(id, 'helixSignal', {
      signalType: parsed.data.signalType,
      signalParams: parsed.data.signalParams,
    });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/executions/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = cancelBody.safeParse(request.body ?? {});
    await deps.executions.cancel(id, parsed.success ? parsed.data.reason : undefined);
    return reply.code(202).send({ ok: true });
  });

  app.get('/api/node-catalogue', async (_request, reply) => {
    return reply.send(getCatalogue());
  });
}
