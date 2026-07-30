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
 * Who a signal came from. An approval step reads the answer's approver from
 * these fields, so if a caller could set them the audit line would be worth
 * nothing: the session decides, the body never does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SingleTenantIdentity, type ExecutionPort, type ExecutionStatusValue } from '@mindlynx/metis-ports';
import {
  AuditStore,
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerAuditTable,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';

/** Records the last signal, which is all this suite is about. */
class RecordingExecutions implements ExecutionPort {
  last?: { name: string; payload?: Record<string, unknown> };

  start(): Promise<{ executionId: string }> {
    return Promise.resolve({ executionId: 'exec-1' });
  }

  signal(_executionId: string, name: string, payload?: Record<string, unknown>): Promise<void> {
    this.last = { name, payload };
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

describe('the signal route stamps who sent it', () => {
  let app: FastifyInstance;
  let executions: RecordingExecutions;
  let audit: AuditStore;
  let adminToken: string;
  let editorToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-signal-actor-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'signals.db')));
    registerWorkflowTables(gateway);
    registerAuditTable(gateway);
    audit = new AuditStore(gateway);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
      { userId: 'sam', secret: 'pw', role: 'editor' },
      { userId: 'watcher', secret: 'pw', role: 'viewer' },
    ]);
    executions = new RecordingExecutions();
    app = buildCoreServer({ identity, store: new WorkflowStore(gateway), executions, audit });
    await app.ready();
    const login = async (userId: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { userId, secret: 'pw' },
      });
      return (response.json() as { token: string }).token;
    };
    adminToken = await login('jeremy');
    editorToken = await login('sam');
    viewerToken = await login('watcher');
  });

  afterAll(async () => {
    await app?.close();
  });

  const signal = (token: string, signalParams?: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/executions/exec-1/signal',
      payload: { signalType: 'approval:node-1', signalParams },
      headers: { authorization: `Bearer ${token}` },
    });

  it('adds the session user and role to the signal params', async () => {
    const response = await signal(adminToken, { decision: 'approved', reason: 'checked' });
    expect(response.statusCode).toBe(202);
    expect(executions.last?.payload?.signalParams).toEqual({
      decision: 'approved',
      reason: 'checked',
      signalledBy: 'jeremy',
      signalledByRole: 'admin',
    });
  });

  it('overwrites an approver the caller tried to claim', async () => {
    await signal(editorToken, {
      decision: 'approved',
      signalledBy: 'jeremy',
      signalledByRole: 'admin',
    });
    expect(executions.last?.payload?.signalParams).toMatchObject({
      signalledBy: 'sam',
      signalledByRole: 'editor',
    });
  });

  it('stamps a signal sent with no params at all', async () => {
    await signal(adminToken);
    expect(executions.last?.payload?.signalParams).toEqual({
      signalledBy: 'jeremy',
      signalledByRole: 'admin',
    });
  });

  it('leaves a scalar payload alone: there is nowhere to put the stamp', async () => {
    await signal(adminToken, 'go');
    expect(executions.last?.payload?.signalParams).toBe('go');
  });

  it('a viewer cannot signal at all, so a viewer can never approve', async () => {
    const response = await signal(viewerToken, { decision: 'approved' });
    expect(response.statusCode).toBe(403);
  });

  // The audit trail's side of the same rule: a decision on a sign-off gate is
  // recorded AS a decision, so "who approved that" is one query rather than a
  // scan of every signal ever sent. A run of its own per case keeps the
  // entries unambiguous.
  const decide = (
    token: string,
    executionId: string,
    signalType: string,
    signalParams: unknown,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/executions/${executionId}/signal`,
      payload: { signalType, signalParams },
      headers: { authorization: `Bearer ${token}` },
    });
  const trailOf = async (executionId: string) =>
    (await audit.list('t1', { entityId: executionId })).map((entry) => ({
      action: entry.action,
      actor: entry.actor,
      signalType: entry.detail?.signalType,
    }));

  it('records an approval as an approval, against the approver', async () => {
    await decide(adminToken, 'exec-approved', 'approval:node-1', {
      decision: 'approved',
      reason: 'checked',
    });
    expect(await trailOf('exec-approved')).toEqual([
      { action: 'approval.approved', actor: 'jeremy', signalType: 'approval:node-1' },
    ]);
  });

  it('records a rejection as a rejection, by the session and not the body', async () => {
    await decide(editorToken, 'exec-rejected', 'approval:node-2', {
      decision: 'rejected',
      signalledBy: 'jeremy',
    });
    expect(await trailOf('exec-rejected')).toEqual([
      { action: 'approval.rejected', actor: 'sam', signalType: 'approval:node-2' },
    ]);
  });

  it('leaves everything else a plain signal, including an unreadable answer', async () => {
    await decide(adminToken, 'exec-other', 'manual', { decision: 'approved' });
    // An answer the approval step would refuse is not named a decision here.
    await decide(adminToken, 'exec-other', 'approval:node-3', { decision: 'maybe' });
    const actions = (await trailOf('exec-other')).map((entry) => entry.action);
    expect(actions).toEqual(['execution.signalled', 'execution.signalled']);
  });
});
