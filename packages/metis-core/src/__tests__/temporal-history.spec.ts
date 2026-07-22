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
 * The history list must report the METIS outcome. Temporal marks a run
 * "completed" whenever the workflow function returns cleanly - including a
 * run Metis recorded as failed (failWorkflow + return {status:'failed'}).
 * The route overlays the store's meta status on Temporal's view.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  FakeCredentialPort,
  FakeExecutionPort,
  SingleTenantIdentity,
  type TemporalExecutionSummary,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';

class ListingPort extends FakeExecutionPort {
  list(): Promise<TemporalExecutionSummary[]> {
    return Promise.resolve([
      {
        workflowId: 'exec_metis_failed',
        runId: 'r1',
        type: 'helixWorkflow',
        // Temporal's view: the workflow function returned, so "completed".
        status: 'completed',
        startTime: '2026-07-06T10:00:00.000Z',
        closeTime: '2026-07-06T10:00:02.000Z',
      },
      {
        workflowId: 'exec_unknown_to_store',
        runId: 'r2',
        type: 'helixWorkflow',
        status: 'running',
        startTime: '2026-07-06T11:00:00.000Z',
      },
    ]);
  }
}

describe('history reports the Metis outcome over Temporal visibility', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    const gateway = new DataGateway(new SqliteAdapter(join(mkdtempSync(join(tmpdir(), 'metis-hist-')), 'h.db')));
    registerWorkflowTables(gateway);
    const store = new WorkflowStore(gateway);
    // Metis knows this run FAILED even though Temporal reports completed.
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: 'exec_metis_failed',
      workflowId: 'wf-1',
      status: 'failed',
      startTime: '2026-07-06T10:00:00.000Z',
      failureReason: 'node boom failed',
    });
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
    ]);
    app = buildCoreServer({
      identity,
      store,
      credentials: new FakeCredentialPort(),
      executions: new ListingPort(),
    });
    await app.ready();
    token = (
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'jeremy', secret: 'pw' } })).json() as {
        token: string;
      }
    ).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('overlays the store status; unknown rows keep the Temporal status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/executions/temporal',
      headers: { authorization: `Bearer ${token}` },
    });
    const { items } = response.json() as { items: TemporalExecutionSummary[] };
    const failed = items.find((item) => item.workflowId === 'exec_metis_failed');
    const unknown = items.find((item) => item.workflowId === 'exec_unknown_to_store');
    expect(failed?.status).toBe('failed');
    expect(unknown?.status).toBe('running');
  });
});
