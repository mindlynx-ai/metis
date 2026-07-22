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
 * Workflow-definition CRUD through the data gateway. Updates
 * are new changesets on the same version (history preserved, never
 * overwritten); publish enforces publish-level validation;
 * deletion is the soft delete of the store.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Session } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import { validateDefinition, type WorkflowDefinition } from '@mindlynx/metis-engine';
import { requireAction } from './auth-gate.js';
import {
  workflowMetaSchema,
  updateWorkflowMetaSchema,
  toHelixWorkflow,
} from './workflow-schema.js';
import type { TriggersPort } from './trigger-mgmt-routes.js';

export function registerWorkflowRoutes(
  app: FastifyInstance,
  store: WorkflowStore,
  triggers?: TriggersPort,
): void {
  const badRequest = (reply: FastifyReply, message: string) =>
    reply.code(400).send({ error: message });

  // A Schedule node in a published graph IS the declaration that the workflow
  // should fire on that cron - without this sync the node was config-only and
  // a published schedule never fired unless a trigger was bound by hand
  // (there is no UI for that). Republish without the node = schedule removed.
  // ponytail: first schedule node wins; node timezone is not carried (the
  // schedule service takes cron only today).
  const syncScheduleTrigger = async (
    workflowId: string,
    definition: Record<string, unknown> | undefined,
  ): Promise<string | undefined> => {
    if (!triggers) return undefined;
    const nodes = (definition?.nodes ?? []) as {
      type?: string;
      config?: { cron?: unknown };
      data?: { config?: { cron?: unknown } };
    }[];
    // Stored definitions carry config Helix-style under data.config; the
    // engine's flattened shape carries it at config. Read both.
    const cronFrom = (n: (typeof nodes)[number]): unknown => n.config?.cron ?? n.data?.config?.cron;
    const wanted = nodes
      .filter((n) => String(n.type ?? '').toLowerCase() === 'scheduleconfig')
      .map(cronFrom)
      .find((cron): cron is string => typeof cron === 'string' && cron.trim() !== '');
    const existing = (await triggers.list()).filter(
      (t) => t.workflowId === workflowId && t.kind === 'schedule',
    );
    if (wanted && existing.length === 1 && existing[0].cron === wanted) return 'live';
    for (const stale of existing) await triggers.remove(String(stale.triggerId));
    if (!wanted) return existing.length > 0 ? 'removed' : undefined;
    await triggers.create({ workflowId, kind: 'schedule', cron: wanted });
    return 'live';
  };

  // The graph is stored under a `definition` wrapper (the engine reads it);
  // the wire shape is Helix-flat top-level nodes/edges. This maps between.
  // cloudRouting (the workflow's cloud toggle + consent stamp) rides the
  // definition so the engine sees it at dispatch without extra plumbing.
  const toDefinition = (
    nodes: unknown[],
    edges: unknown[],
    cloudRouting?: unknown,
  ): Record<string, unknown> => ({
    nodes,
    edges,
    ...(cloudRouting !== undefined ? { cloudRouting } : {}),
  });

  // A graph with an API Start node IS an api workflow (it publishes as a
  // synchronous endpoint), so infer the type rather than asking the editor to
  // set it. Any other graph keeps the given/stored type.
  const inferType = (nodes: unknown[], fallback: string): string =>
    nodes.some((node) => (node as { type?: string }).type === 'apiconfig') ? 'api' : fallback;

  app.post('/api/workflows', { preHandler: requireAction('edit') }, async (request, reply) => {
    const session = request.session as Session;
    const parsed = workflowMetaSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    const workflowId = `wf_${randomUUID()}`;
    await store.putWorkflowVersion({
      tenantId: session.tenantId,
      workflowId,
      version: 1,
      changeset: 0,
      status: parsed.data.status,
      name: parsed.data.name,
      description: parsed.data.description,
      type: inferType(parsed.data.nodes, parsed.data.type),
      definition: toDefinition(parsed.data.nodes, parsed.data.edges, parsed.data.cloudRouting),
    });
    return reply.code(201).send({ id: workflowId, workflowId, version: 1, changeset: 0 });
  });

  // A dry validation of a graph (cycle/loop/branch rules) before saving -
  // lets a builder (human or MCP) check without creating a draft.
  app.post('/api/workflows/validate', async (request, reply) => {
    const parsed = workflowMetaSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    const definition = toDefinition(parsed.data.nodes, parsed.data.edges);
    const result = validateDefinition(definition as unknown as WorkflowDefinition, {
      kind: inferType(parsed.data.nodes, parsed.data.type) === 'api' ? 'api' : 'workflow',
      level: 'publish',
    });
    return reply.send({ valid: result.valid, errors: result.errors });
  });

  app.get('/api/workflows', async (request, reply) => {
    const session = request.session as Session;
    const query = request.query as { status?: string; limit?: string; cursor?: string };
    const page = await store.listWorkflows(session.tenantId, {
      status: query.status,
      limit: Math.min(Number(query.limit ?? 25), 100),
      cursor: query.cursor,
    });
    return reply.send({ items: page.items.map(toHelixWorkflow), cursor: page.cursor });
  });

  app.get('/api/workflows/:workflowId', async (request, reply) => {
    const session = request.session as Session;
    const { workflowId } = request.params as { workflowId: string };
    const query = request.query as { version?: string; changeset?: string };
    const item =
      query.version !== undefined
        ? await store.getWorkflowVersion(
            session.tenantId,
            workflowId,
            Number(query.version),
            Number(query.changeset ?? 0),
          )
        : await store.getLatestVersion(session.tenantId, workflowId);
    if (!item) return reply.code(404).send({ error: 'workflow not found' });
    return reply.send(toHelixWorkflow(item));
  });

  // The changeset history (the Versions panel) - a pure store read.
  app.get('/api/workflows/:workflowId/versions', async (request, reply) => {
    const session = request.session as Session;
    const { workflowId } = request.params as { workflowId: string };
    const items = await store.listVersions(session.tenantId, workflowId);
    return reply.send({
      items: items.map((item) => ({
        version: item.version,
        changeset: item.changeset,
        status: item.status,
        name: item.name,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        steps: (item.definition as { nodes?: unknown[] } | undefined)?.nodes?.length ?? 0,
      })),
    });
  });

  app.patch(
    '/api/workflows/:workflowId',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const session = request.session as Session;
      const { workflowId } = request.params as { workflowId: string };
      const parsed = updateWorkflowMetaSchema.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, parsed.error.issues[0]?.message ?? 'invalid body');
      }
      const latest = await store.getLatestVersion(session.tenantId, workflowId);
      if (!latest) return reply.code(404).send({ error: 'workflow not found' });
      const changeset = latest.changeset + 1;
      const stored = latest.definition as Record<string, unknown>;
      // A settings-only PATCH (cloudRouting without a graph) must not lose
      // the stored graph; a graph PATCH must not lose the stored routing.
      let definition = latest.definition;
      if (parsed.data.nodes !== undefined) {
        const cloudRouting = parsed.data.cloudRouting ?? stored?.cloudRouting;
        definition = toDefinition(parsed.data.nodes, parsed.data.edges ?? [], cloudRouting);
      } else if (parsed.data.cloudRouting !== undefined) {
        definition = { ...stored, cloudRouting: parsed.data.cloudRouting };
      }
      await store.putWorkflowVersion({
        ...latest,
        name: parsed.data.name ?? latest.name,
        description: parsed.data.description ?? latest.description,
        definition,
        // Re-infer when the graph changed (adding/removing an API Start flips it).
        type:
          parsed.data.nodes !== undefined
            ? inferType(parsed.data.nodes, latest.type)
            : latest.type,
        status: 'draft',
        changeset,
      });
      return reply.send({ id: workflowId, workflowId, version: latest.version, changeset });
    },
  );

  app.post(
    '/api/workflows/:workflowId/publish',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const session = request.session as Session;
      const { workflowId } = request.params as { workflowId: string };
      const latest = await store.getLatestVersion(session.tenantId, workflowId);
      if (!latest) return reply.code(404).send({ error: 'workflow not found' });
      const validation = validateDefinition(latest.definition as unknown as WorkflowDefinition, {
        kind: latest.type === 'api' ? 'api' : 'workflow',
        level: 'publish',
      });
      if (!validation.valid) {
        return reply.code(422).send({ error: 'invalid definition', details: validation.errors });
      }
      await store.putWorkflowVersion({ ...latest, status: 'published' });
      let schedule: string | undefined;
      try {
        schedule = await syncScheduleTrigger(
          workflowId,
          latest.definition as Record<string, unknown> | undefined,
        );
      } catch (error) {
        // The version IS published; a schedule that failed to provision must
        // be visible, not silent - the whole bug this sync fixes was silence.
        schedule = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
      return reply.send({
        workflowId,
        version: latest.version,
        changeset: latest.changeset,
        status: 'published',
        ...(schedule !== undefined ? { schedule } : {}),
      });
    },
  );

  app.delete(
    '/api/workflows/:workflowId',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const session = request.session as Session;
      const { workflowId } = request.params as { workflowId: string };
      await store.softDeleteWorkflow(session.tenantId, workflowId);
      // A deleted workflow must not keep firing on its schedule.
      await syncScheduleTrigger(workflowId, undefined).catch(() => undefined);
      return reply.code(204).send();
    },
  );
}
