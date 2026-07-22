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
 * The api-workflow ingress: a request path resolves to a published api-type
 * workflow by its API Start path, runs it synchronously, and maps the outcome
 * to an HTTP response (body + status, 404/500/504).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeExecutionPort, type StartExecutionRequest } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import {
  handleApiWorkflow,
  findPublishedApiWorkflow,
  type ApiWorkflowDeps,
} from '../api-workflow-ingress.js';

function freshStore(): WorkflowStore {
  const gateway = new DataGateway(
    new SqliteAdapter(join(mkdtempSync(join(tmpdir(), 'metis-apiwf-')), 'a.db')),
  );
  registerWorkflowTables(gateway);
  return new WorkflowStore(gateway);
}

const apiDefinition = (path: string, method = 'POST') => ({
  nodes: [
    { id: 'start', type: 'apiconfig', data: { config: { path, method } } },
    { id: 'work', type: 'echo', data: { config: {} } },
    { id: 'end', type: 'apiend', data: { config: { responseType: 'sourcedata' } } },
  ],
  edges: [
    { source: 'start', target: 'work' },
    { source: 'work', target: 'end' },
  ],
});

async function seedPublishedApi(store: WorkflowStore, path: string): Promise<void> {
  await store.putWorkflowVersion({
    tenantId: 't1',
    workflowId: `wf-${path}`,
    version: 1,
    changeset: 0,
    status: 'published',
    name: `api ${path}`,
    type: 'api',
    definition: apiDefinition(path),
  } as never);
}

describe('api workflow ingress', () => {
  let store: WorkflowStore;
  let executions: FakeExecutionPort;
  let deps: ApiWorkflowDeps;

  beforeEach(async () => {
    store = freshStore();
    executions = new FakeExecutionPort();
    deps = { store, executions, tenantId: 't1', newExecutionId: () => 'exec-test' };
    await seedPublishedApi(store, 'orders');
  });

  it('finds a published api workflow by its API Start path, or nothing', async () => {
    expect((await findPublishedApiWorkflow(store, 't1', 'orders', 'POST'))?.workflowId).toBe('wf-orders');
    expect(await findPublishedApiWorkflow(store, 't1', 'nope', 'POST')).toBeUndefined();
    // A leading slash on either side still matches (path normalised).
    expect((await findPublishedApiWorkflow(store, 't1', '/orders', 'POST'))?.workflowId).toBe('wf-orders');
  });

  it('runs the matched workflow and returns apiend body + status', async () => {
    executions.apiRunner = () =>
      Promise.resolve({ executionId: 'e', status: 'completed', response: { ok: 1 }, statusCode: 201 });
    const result = await handleApiWorkflow(deps, { path: 'orders', method: 'POST', body: { a: 1 }, headers: {} });
    expect(result).toEqual({ httpStatus: 201, body: { ok: 1 } });
  });

  it('404s when no api workflow matches the path', async () => {
    const result = await handleApiWorkflow(deps, { path: 'unknown', method: 'POST', body: {}, headers: {} });
    expect(result.httpStatus).toBe(404);
  });

  it('500s when the run fails and 504s when it times out', async () => {
    executions.apiRunner = () => Promise.resolve({ executionId: 'e', status: 'failed' });
    expect((await handleApiWorkflow(deps, { path: 'orders', method: 'POST', body: {}, headers: {} })).httpStatus).toBe(500);
    executions.apiRunner = () => Promise.resolve({ executionId: 'e', status: 'failed', timedOut: true });
    expect((await handleApiWorkflow(deps, { path: 'orders', method: 'POST', body: {}, headers: {} })).httpStatus).toBe(504);
  });

  it('passes the request body through as the run input', async () => {
    let captured: unknown;
    executions.apiRunner = (request: StartExecutionRequest) => {
      captured = request.input;
      return Promise.resolve({ executionId: 'e', status: 'completed', response: {}, statusCode: 200 });
    };
    await handleApiWorkflow(deps, { path: 'orders', method: 'POST', body: { name: 'Ada' }, headers: {} });
    expect(captured).toEqual({ name: 'Ada' });
  });
});
