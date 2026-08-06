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
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * A switch for one deliberately torn write, off for every other test here.
 * `node:fs` exports are non-configurable, so a spy cannot reach them; the
 * module has to be replaced, and the replacement passes straight through until
 * a test asks for the failure.
 */
const fsFault = vi.hoisted(() => ({ tearWrites: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    /**
     * A truncating write that dies in the middle: what a full disk, an OOM kill
     * or a power loss does to the target of a plain writeFileSync. Faithful to
     * both shapes, so what it proves is the implementation and not the mock:
     * given a path it truncates that path, given a descriptor it writes to that
     * descriptor, and either way only half the bytes land.
     */
    writeFileSync: (target: number | fs.PathLike, data: string, options?: unknown) => {
      if (!fsFault.tearWrites) {
        return (actual.writeFileSync as (t: unknown, d: unknown, o?: unknown) => void)(
          target,
          data,
          options,
        );
      }
      const half = data.slice(0, Math.floor(data.length / 2));
      if (typeof target === 'number') {
        actual.writeSync(target, half);
      } else {
        const handle = actual.openSync(target, 'w');
        actual.writeSync(handle, half);
        actual.closeSync(handle);
      }
      throw new Error('ENOSPC: no space left on device');
    },
  };
});
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

  /** A vault holding one secret, plus the pieces needed to read it back. */
  const seeded = async (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `metis-${name}-`));
    const filePath = join(dir, 'credentials.enc');
    const key = randomBytes(32);
    const store = new LocalFileCredentialStore(filePath, key);
    const secretId = 'c0c0c0c0-1111-2222-3333-444444444444';
    await store.setSecret('t1', secretId, 'the-only-copy');
    return { dir, filePath, key, store, request: { tenantId: 't1', secretId } };
  };

  it('leaves nothing beside the vault, and the vault still 0600, after a save', async () => {
    const { dir, filePath, store, request } = await seeded('creds-atomic');
    await store.setSecret('t1', 'd0d0d0d0-1111-2222-3333-444444444444', 'second');
    // The temp file is a means, not a leftover: a half-written copy of the
    // vault must not sit beside it after a save that worked.
    expect(fs.readdirSync(dir)).toEqual(['credentials.enc']);
    // The rename carries the temp file's mode onto the target, so the mode has
    // to be set at creation rather than after the ciphertext is on disk.
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(await store.resolveSecret(request)).toBe('the-only-copy');
  });

  it('a save that dies half way leaves the previous vault intact and readable', async () => {
    const { dir, store, request } = await seeded('creds-torn');
    fsFault.tearWrites = true;
    try {
      await expect(
        store.setSecret('t1', 'e0e0e0e0-1111-2222-3333-444444444444', 'x'),
      ).rejects.toThrow(/ENOSPC/);
    } finally {
      fsFault.tearWrites = false;
    }

    // The whole point: every other credential is still there. Read through a
    // fresh store so it is the FILE being trusted, not anything cached.
    const reopened = new LocalFileCredentialStore(join(dir, 'credentials.enc'), (store as unknown as { key: Buffer }).key);
    expect(await reopened.resolveSecret(request)).toBe('the-only-copy');
    // And the torn copy did not survive as litter next to the secrets.
    expect(fs.readdirSync(dir)).toEqual(['credentials.enc']);
  });

  /**
   * The lost update, from the far side. Two writers here are usually two
   * PROCESSES (the server rotating an OAuth token, an operator on the CLI), so
   * the other one cannot be driven from this test - it is simulated by holding
   * the lock it would hold. What is asserted is the property that makes the
   * lost update impossible: while someone else is inside a read-modify-write,
   * this writer has not read, and has certainly not written.
   */
  it('waits for a writer already inside the vault instead of writing over it', async () => {
    const { dir, filePath, store, request } = await seeded('creds-lock');
    const mine = { tenantId: 't1', secretId: 'f0f0f0f0-1111-2222-3333-444444444444' };
    fs.closeSync(fs.openSync(`${filePath}.lock`, 'wx'));

    const pending = store.setSecret(mine.tenantId, mine.secretId, 'mine');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(store.resolveSecret(mine)).rejects.toThrow(/not defined/);

    fs.rmSync(`${filePath}.lock`);
    await pending;
    expect(await store.resolveSecret(mine)).toBe('mine');
    // And the other writer's entry survived, which is the whole point.
    expect(await store.resolveSecret(request)).toBe('the-only-copy');
    expect(fs.readdirSync(dir)).toEqual(['credentials.enc']);
  });

  it('takes over a lock left behind by a writer that was killed', async () => {
    const { filePath, store, request } = await seeded('creds-stale');
    const lockPath = `${filePath}.lock`;
    fs.closeSync(fs.openSync(lockPath, 'wx'));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    await store.setSecret('t1', 'a1a1a1a1-1111-2222-3333-444444444444', 'after the crash');
    expect(await store.resolveSecret(request)).toBe('the-only-copy');
    expect(
      await store.resolveSecret({ tenantId: 't1', secretId: 'a1a1a1a1-1111-2222-3333-444444444444' }),
    ).toBe('after the crash');
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
