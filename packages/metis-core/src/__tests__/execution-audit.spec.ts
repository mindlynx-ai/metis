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
 * Who ran it, and who ran it again. Cancelling and terminating a run were on
 * the trail long before starting one was, which left the most basic question an
 * auditor asks - "who ran this?" - with no answer anywhere: the run log carries
 * no actor and the execution row has no requestedBy field. A reset re-runs the
 * work from the first task, so it repeats every side effect the run had, and it
 * sat unrecorded between the two lifecycle actions that were recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  SingleTenantIdentity,
  type ExecutionPort,
  type ExecutionStatusValue,
} from '@mindlynx/metis-ports';
import {
  AuditStore,
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerAuditTable,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';

/** Enough of the port to start and reset, recording that it happened. */
class RecordingExecutions implements ExecutionPort {
  readonly started: string[] = [];
  readonly resets: { executionId: string; reason?: string }[] = [];

  start(request: { executionId: string }): Promise<{ executionId: string }> {
    this.started.push(request.executionId);
    return Promise.resolve({ executionId: request.executionId });
  }

  reset(executionId: string, reason?: string): Promise<{ runId: string }> {
    this.resets.push({ executionId, reason });
    return Promise.resolve({ runId: 'run-2' });
  }

  signal(): Promise<void> {
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  queryStatus(): Promise<ExecutionStatusValue> {
    return Promise.resolve('running');
  }

  describe(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
}

/** A definition that passes start-level validation: a trigger and one step. */
const DEFINITION = {
  nodes: [
    { id: 'e1b2c3d4-1111-4222-8333-444444444444', type: 'webhookconfig', data: { config: {} } },
    {
      id: 'f1b2c3d4-1111-4222-8333-444444444444',
      type: 'code',
      data: { config: { code: 'return 1' } },
    },
  ],
  edges: [
    {
      source: 'e1b2c3d4-1111-4222-8333-444444444444',
      target: 'f1b2c3d4-1111-4222-8333-444444444444',
    },
  ],
};

describe('starting and re-running a workflow are attributable', () => {
  let app: FastifyInstance;
  let audit: AuditStore;
  let executions: RecordingExecutions;
  let token: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-exec-audit-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'exec.db')));
    registerWorkflowTables(gateway);
    registerAuditTable(gateway);
    audit = new AuditStore(gateway);
    executions = new RecordingExecutions();
    const store = new WorkflowStore(gateway);
    // The run the reset below acts on: the lifecycle routes require it to be
    // one this instance started before they will touch Temporal for it.
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: 'exec-reset-me',
      workflowId: 'wf-1',
      status: 'failed',
      startTime: new Date().toISOString(),
    } as never);
    app = buildCoreServer({
      identity: await SingleTenantIdentity.create('t1', [
        { userId: 'jeremy', secret: 'pw', role: 'admin' },
      ]),
      store,
      executions,
      audit,
    });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: 'jeremy', secret: 'pw' },
    });
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('records who started a run, against the run, naming the workflow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers: { authorization: `Bearer ${token}` },
      payload: { workflowId: 'wf-payouts', definition: DEFINITION },
    });
    expect(response.statusCode).toBe(202);
    const { executionId } = response.json() as { executionId: string };
    // The run really started: the trail is not a line written beside nothing.
    expect(executions.started).toEqual([executionId]);

    const entries = await audit.list('t1', { entityId: executionId });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'execution.started',
      actor: 'jeremy',
      entityType: 'execution',
      outcome: 'ok',
      detail: { workflowId: 'wf-payouts' },
    });
  });

  it('records who re-ran one, under its own name and with the reason given', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/executions/exec-reset-me/reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'the connector was down' },
    });
    expect(response.statusCode).toBe(202);
    expect(executions.resets).toEqual([
      { executionId: 'exec-reset-me', reason: 'the connector was down' },
    ]);

    const entries = await audit.list('t1', { entityId: 'exec-reset-me' });
    // Its own action name, not execution.started or a flag on another entry:
    // the trail filters actions by equality, so "who re-ran this" has to be a
    // name an auditor can ask for.
    expect(entries.map((entry) => entry.action)).toEqual(['execution.reset']);
    expect(entries[0]).toMatchObject({
      actor: 'jeremy',
      entityType: 'execution',
      detail: { reason: 'the connector was down' },
    });
  });
});
