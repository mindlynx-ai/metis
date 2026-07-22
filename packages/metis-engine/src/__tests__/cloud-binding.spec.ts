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
 * The engine end of uplift routing: executeNode threads `routing` into the
 * port, the chosen backend lands on the run log as `binding`, and a
 * degraded bind marks the whole run's meta - the facts the run views draw.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityGatewayClient,
  CapabilityResolver,
  CapturingEventSink,
  FakeCredentialPort,
  NodeHandlerRegistry,
  startHelixStub,
  type HelixStub,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import type { CloudRoutingContext } from '../types.js';

const stubs: HelixStub[] = [];
afterAll(async () => {
  await Promise.all(stubs.map((stub) => stub.close()));
});

async function harness(gatewayUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'metis-binding-'));
  const gateway = new DataGateway(new SqliteAdapter(join(dir, 'binding.db')));
  registerWorkflowTables(gateway);
  const store = new WorkflowStore(gateway);
  const registry = new NodeHandlerRegistry();
  registry.registerNodeHandler('data', () =>
    Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { ranIn: 'local' } } }),
  );
  const nodes = gatewayUrl
    ? new CapabilityResolver({
        local: registry,
        entryFor: (type) => (type === 'data' ? { execution: 'both', entitlement: 'cap.data' } : undefined),
        entitlements: async () => new Set(['cap.data']),
        gateway: new CapabilityGatewayClient({
          baseUrl: gatewayUrl,
          getBearer: async () => 'bearer',
          timeoutMs: 1_000,
        }),
      })
    : registry;
  const activities = createActivities({
    store,
    events: new CapturingEventSink(),
    nodes,
    credentials: new FakeCredentialPort(),
  });
  await store.writeExecutionMeta({
    tenantId: 't1',
    executionId: 'exec_bind',
    workflowId: 'wf_bind',
    status: 'running',
    startTime: new Date().toISOString(),
  });
  return { activities, store };
}

function requestFor(routing?: CloudRoutingContext) {
  return {
    tenantId: 't1',
    workflowId: 'wf_bind',
    executionId: 'exec_bind',
    node: { id: 'n1', type: 'data', config: {} },
    states: [],
    sequence: 1,
    routing,
  };
}

const CHOSEN: CloudRoutingContext = {
  enabled: true,
  consentAt: '2026-07-18T09:00:00Z',
  nodeMode: 'cloud',
};

describe('executeNode cloud binding', () => {
  it('an unreachable cloud degrades: local run, binding on the log, run marked', async () => {
    const { activities, store } = await harness('http://127.0.0.1:1');
    const result = await activities.executeNode(requestFor(CHOSEN));
    expect(result.outcome).toBe('completed');
    expect(result.output).toMatchObject({ ranIn: 'local' });
    const execution = await store.getExecution('t1', 'exec_bind');
    const done = execution?.logs.find((log) => log.event === 'workflow.node.completed');
    expect(done?.binding).toBe('local-degraded');
    expect(execution?.meta.degraded).toBe(true);
  });

  it('binds cloud for real with a valid bearer and leaves the run unmarked', async () => {
    const stub = await startHelixStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'metis-binding-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'binding.db')));
    registerWorkflowTables(gateway);
    const store = new WorkflowStore(gateway);
    const registry = new NodeHandlerRegistry();
    registry.registerNodeHandler('data', () =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { ranIn: 'local' } } }),
    );
    const activities = createActivities({
      store,
      events: new CapturingEventSink(),
      nodes: new CapabilityResolver({
        local: registry,
        entryFor: () => ({ execution: 'both', entitlement: 'cap.data' }),
        entitlements: async () => new Set(['cap.data']),
        gateway: new CapabilityGatewayClient({
          baseUrl: stub.url,
          getBearer: async () => stub.issueToken(),
          timeoutMs: 1_000,
        }),
      }),
      credentials: new FakeCredentialPort(),
    });
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: 'exec_bind',
      workflowId: 'wf_bind',
      status: 'running',
      startTime: new Date().toISOString(),
    });
    const result = await activities.executeNode(requestFor(CHOSEN));
    expect(result.outcome).toBe('completed');
    expect(result.output).toMatchObject({ cloud: true, capability: 'data' });
    const execution = await store.getExecution('t1', 'exec_bind');
    expect(execution?.logs.find((log) => log.event === 'workflow.node.completed')?.binding).toBe(
      'cloud',
    );
    expect(execution?.meta.degraded).toBeUndefined();
  });

  it('a plain local run carries no binding at all', async () => {
    const { activities, store } = await harness(undefined);
    const result = await activities.executeNode(requestFor(undefined));
    expect(result.outcome).toBe('completed');
    const execution = await store.getExecution('t1', 'exec_bind');
    expect(execution?.logs.find((log) => log.event === 'workflow.node.completed')?.binding).toBeUndefined();
    expect(execution?.meta.degraded).toBeUndefined();
  });
});
