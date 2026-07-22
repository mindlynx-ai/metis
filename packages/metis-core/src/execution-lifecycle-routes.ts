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
 * Execution lifecycle routes for the collapsed laptop runtime. When metis-core is given an ExecutionPort it drives runs
 * directly, so the whole product is one origin: start (resolving the
 * published definition), signal, cancel, status and describe. At scale
 * these live in the orchestrator instead.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExecutionPort, Session } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import { validateDefinition, type WorkflowDefinition } from '@mindlynx/metis-engine';
import { requireAction } from './auth-gate.js';
import { deriveWhereabouts, labelMapOf } from './whereabouts.js';

const startBody = z.object({
  workflowId: z.string().min(1),
  definition: z
    .object({
      nodes: z.array(z.record(z.unknown())),
      edges: z.array(z.record(z.unknown())),
      cloudRouting: z.object({ enabled: z.boolean(), consentAt: z.string().optional() }).optional(),
    })
    .optional(),
  input: z.record(z.unknown()).optional(),
  type: z.enum(['workflow', 'api']).default('workflow'),
  // The consent gate's per-run answer: true = "send to the cloud" WITHOUT
  // "don't ask again", so consent applies to this run only.
  cloudConsent: z.boolean().optional(),
});

const signalBody = z.object({ signalType: z.string().min(1), signalParams: z.unknown().optional() });
const cancelBody = z.object({ reason: z.string().optional() });

/** The consent receipt line, when the run's workflow has cloud routing on. */
async function appendConsentReceipt(
  store: WorkflowStore,
  session: Session,
  executionId: string,
  definition: unknown,
  cloudConsent: boolean | undefined,
): Promise<void> {
  const effective = (definition as { cloudRouting?: { enabled?: boolean; consentAt?: string } })
    .cloudRouting;
  if (!effective?.enabled) return;
  await store.appendExecutionLog({
    tenantId: session.tenantId,
    executionId,
    sequence: 1,
    event: 'workflow.cloud.routing',
    decision: effective.consentAt ? 'allowed' : 'kept-local',
    consentAt: effective.consentAt,
    // 'run' = the one-off yes (no "don't ask again"); the receipt line
    // renders "for all future runs" only for a remembered consent.
    ...(effective.consentAt ? { scope: cloudConsent ? 'run' : 'workflow' } : {}),
    requestedBy: session.userId,
    at: new Date().toISOString(),
  });
}

export function registerExecutionLifecycleRoutes(
  app: FastifyInstance,
  store: WorkflowStore,
  executions: ExecutionPort,
): void {
  app.post('/api/executions', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const parsed = startBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const body = parsed.data;
    let definition = body.definition as WorkflowDefinition | undefined;
    if (!definition) {
      const published = await store.getLatestPublished(session.tenantId, body.workflowId);
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
    // Per-run consent: stamp consentAt into THIS run's definition copy only;
    // the stored workflow is untouched (that path is the "don't ask again"
    // save). The resolver refuses cloud without the stamp, so this is the
    // single place a run-scoped yes becomes effective.
    const routing = (definition as { cloudRouting?: { enabled?: boolean; consentAt?: string } })
      .cloudRouting;
    if (body.cloudConsent && routing?.enabled && !routing.consentAt) {
      definition = {
        ...definition,
        cloudRouting: { ...routing, consentAt: new Date().toISOString() },
      } as WorkflowDefinition;
    }
    const executionId = `exec_${randomUUID()}`;
    // Stamp WHICH definition version this run executes (best-effort lookup).
    const latest = await store.getLatestVersion(session.tenantId, body.workflowId).catch(() => undefined);
    const started = await executions.start({
      tenantId: session.tenantId,
      workflowId: body.workflowId,
      executionId,
      workflowType: body.type === 'api' ? 'helixApiWorkflow' : 'helixWorkflow',
      definition,
      input: body.input,
      definitionVersion: latest?.version,
      definitionChangeset: latest?.changeset,
    } as never);
    // The consent receipt: when this workflow has cloud routing switched on,
    // the decision that governs this run lands in its history (sequence 1;
    // engine node lines start at 11, so the receipt always sorts first).
    await appendConsentReceipt(store, session, executionId, definition, body.cloudConsent);
    return reply.code(202).send({ executionId, runId: started.runId, status: 'running' });
  });

  // The history list as Temporal's visibility API sees it, overlaid with the
  // store's outcome: a Metis-failed run still RETURNS cleanly from the
  // workflow function, so Temporal alone reports it "completed".
  // Mission control: status counts + worker/queue health in one call.
  app.get('/api/operate/summary', async (_request, reply) => {
    const counts = executions.countByStatus ? await executions.countByStatus() : undefined;
    const queue = executions.taskQueueHealth ? await executions.taskQueueHealth() : undefined;
    return reply.send({ counts, queue });
  });

  // Hard stop: Temporal terminate (the graceful path is /cancel).
  app.post(
    '/api/executions/:id/terminate',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      if (!executions.terminate) return reply.code(501).send({ error: 'terminate not supported' });
      const { id } = request.params as { id: string };
      const parsed = cancelBody.safeParse(request.body ?? {});
      await executions.terminate(id, parsed.success ? parsed.data.reason : undefined);
      return reply.code(202).send({ executionId: id, status: 'terminating' });
    },
  );

  // Reset: re-run the execution from its first workflow task.
  app.post(
    '/api/executions/:id/reset',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      if (!executions.reset) return reply.code(501).send({ error: 'reset not supported' });
      const { id } = request.params as { id: string };
      const parsed = cancelBody.safeParse(request.body ?? {});
      const result = await executions.reset(id, parsed.success ? parsed.data.reason : undefined);
      return reply.code(202).send({ executionId: id, runId: result.runId });
    },
  );

  // The ARCHIVE: closed runs OUR store still remembers after Temporal's
  // visibility (dev-server retention is short) has forgotten them. The
  // detail page reads the store, so archived runs stay fully inspectable.
  app.get('/api/executions/archive', async (request, reply) => {
    const session = request.session as Session;
    const visible = executions.list ? await executions.list({ limit: 100 }).catch(() => []) : [];
    const visibleIds = new Set(visible.map((item) => item.workflowId));
    const known = await store.listExecutions(session.tenantId, { limit: 100 });
    const nameCache = new Map<string, string | undefined>();
    const nameOf = async (metisWorkflowId: string) => {
      if (!nameCache.has(metisWorkflowId)) {
        const latest = await store.getLatestVersion(session.tenantId, metisWorkflowId);
        nameCache.set(metisWorkflowId, latest?.name);
      }
      return nameCache.get(metisWorkflowId);
    };
    const archived = await Promise.all(
      known.items
        .filter(
          (meta) =>
            meta.status !== 'running' &&
            !visibleIds.has(meta.executionId) &&
            // ponytail: loop children would flood the list; reachable via
            // their parent's Related runs instead.
            !meta.executionId.includes('-loop-'),
        )
        .map(async (meta) => ({
          executionId: meta.executionId,
          workflowId: meta.workflowId,
          workflowName: await nameOf(String(meta.workflowId)),
          status: meta.status,
          startTime: meta.startTime,
          endTime: (meta as { endTime?: string }).endTime,
          definitionVersion: meta.definitionVersion,
          definitionChangeset: meta.definitionChangeset,
        })),
    );
    return reply.send({ items: archived, retentionDays: store.retentionDays });
  });

  app.get('/api/executions/temporal', async (request, reply) => {
    if (!executions.list) return reply.send({ items: [] });
    const session = request.session as Session;
    const query = request.query as { limit?: string; status?: string };
    // Server-side visibility filter: Temporal does the filtering, not the browser.
    const visibility =
      query.status && /^[A-Za-z]+$/.test(query.status)
        ? `ExecutionStatus="${query.status}"`
        : undefined;
    const items = await executions.list({
      limit: Math.min(Number(query.limit ?? 50), 100),
      ...(visibility ? { query: visibility } : {}),
    });
    const known = await store.listExecutions(session.tenantId, { limit: 100 });
    const metaById = new Map(known.items.map((meta) => [meta.executionId, meta]));

    // Name lookup + node labels per METIS workflow, cached per request.
    const workflowCache = new Map<string, { name?: string; labels: Map<string, string> }>();
    const workflowInfo = async (metisWorkflowId: string | undefined) => {
      if (!metisWorkflowId) return undefined;
      let cached = workflowCache.get(metisWorkflowId);
      if (!cached) {
        const latest = await store.getLatestVersion(session.tenantId, metisWorkflowId);
        cached = { name: latest?.name, labels: labelMapOf(latest?.definition) };
        workflowCache.set(metisWorkflowId, cached);
      }
      return cached;
    };

    const merged = await Promise.all(
      items.map(async (item) => {
        // Temporal's workflowId IS the Metis executionId.
        const meta = metaById.get(item.workflowId);
        const status = meta?.status ?? item.status;
        const info = await workflowInfo(meta ? String(meta.workflowId) : undefined);
        const base = {
          ...item,
          status,
          workflowName: info?.name,
          metisWorkflowId: meta ? String(meta.workflowId) : undefined,
          definitionVersion: meta?.definitionVersion,
          definitionChangeset: meta?.definitionChangeset,
        };
        if (status !== 'running') return base;
        // Whereabouts for the (small) running set: parked or at which step.
        const detail = await store.getExecution(session.tenantId, item.workflowId);
        if (!detail) return base;
        const where = deriveWhereabouts(detail.logs as Record<string, unknown>[], (nodeId) => info?.labels.get(nodeId));
        return { ...base, ...where };
      }),
    );
    return reply.send({ items: merged });
  });

  // Runtime insight for ONE run: its family (parent / children - loop
  // iterations are real child runs), pending-activity retries, and
  // whereabouts (parked or at which step). One call for the detail page.
  app.get('/api/executions/:id/insight', async (request, reply) => {
    const session = request.session as Session;
    const { id } = request.params as { id: string };
    const [described, childItems, detail] = await Promise.all([
      executions.describe(id).catch(() => undefined),
      executions.list
        ? executions.list({ limit: 50, query: `ParentWorkflowId="${id.replaceAll('"', '')}"` }).catch(() => [])
        : Promise.resolve([]),
      store.getExecution(session.tenantId, id),
    ]);
    const meta = detail?.meta;
    const info = meta
      ? await store.getLatestVersion(session.tenantId, String(meta.workflowId))
      : undefined;
    const labels = labelMapOf(info?.definition);
    const whereabouts =
      meta?.status === 'running' && detail
        ? deriveWhereabouts(detail.logs as Record<string, unknown>[], (nodeId) => labels.get(nodeId))
        : undefined;
    return reply.send({
      executionId: id,
      workflowName: info?.name,
      parentExecutionId: described?.parentExecutionId,
      pendingActivities: described?.pendingActivities ?? [],
      children: childItems.map((child) => ({
        executionId: child.workflowId,
        runId: child.runId,
        status: child.status,
        startTime: child.startTime,
      })),
      whereabouts,
    });
  });

  app.get('/api/executions/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ executionId: id, status: await executions.queryStatus(id) });
  });

  app.get('/api/executions/:id/describe', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await executions.describe(id));
  });

  app.post(
    '/api/executions/:id/signal',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = signalBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
      }
      await executions.signal(id, 'helixSignal', {
        signalType: parsed.data.signalType,
        signalParams: parsed.data.signalParams,
      });
      return reply.code(202).send({ ok: true });
    },
  );

  app.post(
    '/api/executions/:id/cancel',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = cancelBody.safeParse(request.body ?? {});
      await executions.cancel(id, parsed.success ? parsed.data.reason : undefined);
      return reply.code(202).send({ ok: true });
    },
  );
}
