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
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { EventSink, NodeExecPort, IdentityPort, CredentialPort } from '../../index.js';
import {
  StdoutEventSink,
  NodeHandlerRegistry,
  SingleTenantIdentity,
  LocalFileCredentialStore,
  nodeCtx,
  nodeOutput,
} from '../../index.js';

describe('StdoutEventSink', () => {
  it('writes one structured JSON line per event and never throws', () => {
    const lines: string[] = [];
    const sink: EventSink = new StdoutEventSink((line) => lines.push(line));
    sink.emit({
      name: 'workflow.node.completed',
      tenantId: 't1',
      executionId: 'e1',
      nodeId: 'n1',
      timestamp: '2026-07-03T10:00:00.000Z',
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed.name).toBe('workflow.node.completed');
    expect(parsed.nodeId).toBe('n1');
  });

  it('swallows writer failures (fire-and-forget)', () => {
    const sink = new StdoutEventSink(() => {
      throw new Error('broken pipe');
    });
    expect(() =>
      sink.emit({
        name: 'workflow.execution.failed',
        tenantId: 't1',
        timestamp: '2026-07-03T10:00:00.000Z',
      }),
    ).not.toThrow();
  });
});

describe('NodeHandlerRegistry', () => {
  it('registers a handler and executes it in process', async () => {
    const registry = new NodeHandlerRegistry();
    registry.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: ctx.nodeRef.config } }),
    );
    const port: NodeExecPort = registry;
    expect(port.canExecute('echo')).toBe(true);
    const result = await port.execute(nodeCtx('echo', { value: 42 }));
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toEqual({ value: 42 });
  });

  it('rejects duplicate registration and yields the upgrade response for unknown types', async () => {
    const registry = new NodeHandlerRegistry();
    registry.registerNodeHandler('once', () => Promise.resolve({ status: 200, message: 'ok' }));
    expect(() =>
      registry.registerNodeHandler('once', () => Promise.resolve({ status: 200, message: 'ok' })),
    ).toThrow(/already registered/i);
    const result = await registry.execute(nodeCtx('cortex.memory.read', {}));
    expect(result.status).toBe(501);
    expect(result.message).toMatch(/not available/i);
  });

  it('turns a throwing handler into a failed outcome', async () => {
    const registry = new NodeHandlerRegistry();
    registry.registerNodeHandler('boom', () => Promise.reject(new Error('exploded')));
    const result = await registry.execute(nodeCtx('boom', {}));
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/exploded/);
  });
});

describe('SingleTenantIdentity', () => {
  it('authenticates with hashed secrets and issues verifiable tokens', async () => {
    const identity: IdentityPort = await SingleTenantIdentity.create('tenant-1', [
      { userId: 'jeremy', secret: 'correct-horse', role: 'admin' },
    ]);
    const session = await identity.authenticate('jeremy', 'correct-horse');
    expect(session?.role).toBe('admin');
    expect(await identity.authenticate('jeremy', 'wrong')).toBeUndefined();

    const withTokens = identity as SingleTenantIdentity;
    const token = withTokens.issueToken(session!);
    const verified = await identity.verify(token);
    expect(verified?.userId).toBe('jeremy');
    expect(await identity.verify('forged-token')).toBeUndefined();
  });
});

describe('LocalFileCredentialStore (BYOK)', () => {
  it('round-trips secrets through an encrypted file with no plaintext on disk or in logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-creds-'));
    const filePath = join(dir, 'credentials.enc');
    const key = randomBytes(32);
    const store = new LocalFileCredentialStore(filePath, key);
    await store.setSecret('t1', 'a0a0a0a0-1111-2222-3333-444444444444', 'super-plain-secret');
    const conn = await store.createConnection('t1', {
      name: 'My CRM',
      connectorId: 'crm',
      material: { apiKey: 'plain-api-key' },
    });

    const raw = readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('super-plain-secret');
    expect(raw).not.toContain('plain-api-key');
    expect(JSON.stringify(store)).not.toContain('super-plain-secret');
    expect(String(store)).not.toContain('super-plain-secret');

    const port: CredentialPort = store;
    expect(
      await port.resolveSecret({ tenantId: 't1', secretId: 'a0a0a0a0-1111-2222-3333-444444444444' }),
    ).toBe('super-plain-secret');
    expect(await port.resolveConnectorCredentials('t1', conn.connectionId)).toEqual({ apiKey: 'plain-api-key' });
    // The list projects metadata only, never the material.
    const listed = await store.listConnections('t1');
    expect(listed).toEqual([{ connectionId: conn.connectionId, name: 'My CRM', connectorId: 'crm', createdAt: conn.createdAt, updatedAt: conn.updatedAt }]);
    expect(raw).not.toContain('plain-api-key');

    const reopened = new LocalFileCredentialStore(filePath, key);
    expect(
      await reopened.resolveSecret({ tenantId: 't1', secretId: 'a0a0a0a0-1111-2222-3333-444444444444' }),
    ).toBe('super-plain-secret');
  });

  it('refuses to decrypt with the wrong key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-creds-'));
    const filePath = join(dir, 'credentials.enc');
    const store = new LocalFileCredentialStore(filePath, randomBytes(32));
    await store.setSecret('t1', 'b0b0b0b0-1111-2222-3333-444444444444', 'value');
    const wrongKey = new LocalFileCredentialStore(filePath, randomBytes(32));
    await expect(
      wrongKey.resolveSecret({ tenantId: 't1', secretId: 'b0b0b0b0-1111-2222-3333-444444444444' }),
    ).rejects.toThrow();
  });
});
