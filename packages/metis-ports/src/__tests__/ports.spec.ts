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
import { describe, it, expect } from 'vitest';
import type {
  DataStore,
  NodeExecPort,
  CredentialPort,
  EventSink,
  ExecutionPort,
  IdentityPort,
} from '../index.js';
import {
  FakeDataStore,
  FakeNodeExecPort,
  FakeCredentialPort,
  CapturingEventSink,
  FakeExecutionPort,
  FakeIdentityPort,
  WORKFLOW_EVENT_NAMES,
  nodeCtx,
  nodeOutput,
} from '../index.js';

describe('DataStore port', () => {
  const store: DataStore = new FakeDataStore();
  store.registerTable({
    name: 'workflows',
    partitionAttribute: 'PK',
    sortAttribute: 'SK',
    indexes: [{ name: 'byUpdated', partitionAttribute: 'gsi1pk', sortAttribute: 'updatedAt' }],
  });

  it('gets what it puts, keyed by partition and sort', async () => {
    await store.put('workflows', { PK: 'WF#t1#wf1', SK: 'VER#1#0', name: 'first' });
    const item = await store.get('workflows', { partitionKey: 'WF#t1#wf1', sortKey: 'VER#1#0' });
    expect(item?.name).toBe('first');
  });

  it('honours conditional writes by key', async () => {
    await store.put('workflows', { PK: 'WF#t1#wf2', SK: 'VER#1#0' }, { condition: 'must-not-exist' });
    await expect(
      store.put('workflows', { PK: 'WF#t1#wf2', SK: 'VER#1#0' }, { condition: 'must-not-exist' }),
    ).rejects.toThrow(/exists/i);
    await expect(
      store.put('workflows', { PK: 'WF#t1#missing', SK: 'VER#9#9' }, { condition: 'must-exist' }),
    ).rejects.toThrow(/exist/i);
  });

  it('queries a partition in sort order with prefix, limit and cursor', async () => {
    for (const n of [1, 2, 3]) {
      await store.put('workflows', { PK: 'WF#t1#wf3', SK: `VER#${n}#0`, n });
    }
    const first = await store.query({
      table: 'workflows',
      partitionValue: 'WF#t1#wf3',
      sortPrefix: 'VER#',
      limit: 2,
    });
    expect(first.items.map((i) => i.n)).toEqual([1, 2]);
    expect(first.cursor).toBeDefined();
    const rest = await store.query({
      table: 'workflows',
      partitionValue: 'WF#t1#wf3',
      sortPrefix: 'VER#',
      cursor: first.cursor,
    });
    expect(rest.items.map((i) => i.n)).toEqual([3]);
    expect(rest.cursor).toBeUndefined();
  });

  it('queries a secondary index', async () => {
    await store.put('workflows', { PK: 'WF#t2#a', SK: 'VER#1#0', gsi1pk: 'TENANT#t2', updatedAt: '2026-01-02' });
    await store.put('workflows', { PK: 'WF#t2#b', SK: 'VER#1#0', gsi1pk: 'TENANT#t2', updatedAt: '2026-01-01' });
    const page = await store.query({
      table: 'workflows',
      index: 'byUpdated',
      partitionValue: 'TENANT#t2',
      ascending: false,
    });
    expect(page.items.map((i) => i.PK)).toEqual(['WF#t2#a', 'WF#t2#b']);
  });

  it('patches and deletes by key', async () => {
    await store.put('workflows', { PK: 'WF#t1#wf4', SK: 'META', status: 'running' });
    await store.patch('workflows', { partitionKey: 'WF#t1#wf4', sortKey: 'META' }, { status: 'completed' });
    const patched = await store.get('workflows', { partitionKey: 'WF#t1#wf4', sortKey: 'META' });
    expect(patched?.status).toBe('completed');
    await store.deleteItem('workflows', { partitionKey: 'WF#t1#wf4', sortKey: 'META' });
    expect(await store.get('workflows', { partitionKey: 'WF#t1#wf4', sortKey: 'META' })).toBeUndefined();
  });
});

describe('NodeExecPort', () => {
  const exec: NodeExecPort = new FakeNodeExecPort({
    echo: (ctx) => Promise.resolve({ status: 200, message: 'ok', nodeData: { data: ctx.nodeRef.config } }),
  });

  it('runs a registered node type', async () => {
    const result = await exec.execute(nodeCtx('echo', { greeting: 'hello' }));
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toEqual({ greeting: 'hello' });
  });

  it('reports an unregistered type as unimplemented, not an error', async () => {
    expect(exec.canExecute('missing')).toBe(false);
    const result = await exec.execute(nodeCtx('missing', {}));
    expect(result.status).toBe(501);
  });
});

describe('CredentialPort', () => {
  const credentials: CredentialPort = new FakeCredentialPort(
    { 't1/8d5c2f4a-1111-2222-3333-444455556666': 'shh' },
    { 't1/conn1': { name: 'conn1', connectorId: 'conn1', material: { apiKey: 'k-123' } } },
  );

  it('resolves a secret reference at dispatch time', async () => {
    const value = await credentials.resolveSecret({
      tenantId: 't1',
      secretId: '8d5c2f4a-1111-2222-3333-444455556666',
    });
    expect(value).toBe('shh');
  });

  it('resolves connector credentials', async () => {
    const material = await credentials.resolveConnectorCredentials('t1', 'conn1');
    expect(material.apiKey).toBe('k-123');
  });
});

describe('EventSink', () => {
  it('captures fire-and-forget workflow events', () => {
    const sink = new CapturingEventSink();
    const asPort: EventSink = sink;
    asPort.emit({
      name: 'workflow.execution.started',
      tenantId: 't1',
      executionId: 'e1',
      timestamp: '2026-07-03T00:00:00.000Z',
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.name).toBe('workflow.execution.started');
  });

  it('names all eleven lifecycle events', () => {
    expect(WORKFLOW_EVENT_NAMES).toHaveLength(11);
    expect(WORKFLOW_EVENT_NAMES).toContain('workflow.node.unimplemented');
    expect(WORKFLOW_EVENT_NAMES).toContain('workflow.signal.received');
  });
});

describe('ExecutionPort', () => {
  const executions: ExecutionPort = new FakeExecutionPort();

  it('starts, queries, signals and cancels a durable run', async () => {
    const { executionId } = await executions.start({
      tenantId: 't1',
      workflowId: 'wf1',
      executionId: 'e-100',
      workflowType: 'helixWorkflow',
      input: { hello: true },
    });
    expect(executionId).toBe('e-100');
    expect(await executions.queryStatus('e-100')).toBe('running');
    await executions.signal('e-100', 'helixSignal', { signalType: 'poke' });
    await executions.cancel('e-100', 'test finished');
    expect(await executions.queryStatus('e-100')).toBe('cancelled');
    const description = await executions.describe('e-100');
    expect(description.workflowType).toBe('helixWorkflow');
  });
});

describe('IdentityPort', () => {
  const identity: IdentityPort = new FakeIdentityPort('tenant-1', [
    { userId: 'jeremy', secret: 'pw', role: 'admin' },
    { userId: 'viewer', secret: 'pw', role: 'viewer' },
  ]);

  it('authenticates a user into the single tenant', async () => {
    const session = await identity.authenticate('jeremy', 'pw');
    expect(session?.tenantId).toBe('tenant-1');
    expect(session?.role).toBe('admin');
    expect(await identity.authenticate('jeremy', 'wrong')).toBeUndefined();
  });

  it('gates edit vs view by simple role', async () => {
    const admin = await identity.authenticate('jeremy', 'pw');
    const viewer = await identity.authenticate('viewer', 'pw');
    expect(admin && identity.can(admin, 'edit')).toBe(true);
    expect(viewer && identity.can(viewer, 'edit')).toBe(false);
    expect(viewer && identity.can(viewer, 'view')).toBe(true);
  });
});
