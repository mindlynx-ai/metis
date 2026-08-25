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
 * The hub has to serve EVERY address the app is listening on.
 *
 * `metis up` binds loopback, and loopback is two addresses: 127.0.0.1 and ::1.
 * Fastify binds both and keeps the second in `Symbol.for('fastify.serverBindings')`
 * - but the hub was attached to `app.server` alone, so whichever stack the
 * browser did not pick got working HTTP and a websocket upgrade that Node
 * destroyed for want of a listener. Windows resolves `localhost` to ::1 first,
 * which is why the page loaded there and the socket did not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as socketClient, type Socket } from 'socket.io-client';
import { LocalEventBus, type IdentityPort } from '@mindlynx/metis-ports';
import { attachSocketHub, type SocketHub } from '../socket-hub.js';

const identity = {
  verify: (token: string) =>
    Promise.resolve(token === 'good' ? { userId: 'u1', tenantId: 't1', role: 'admin' } : undefined),
} as unknown as IdentityPort;

const bus = new LocalEventBus();
let first: HttpServer;
let second: HttpServer;
let hub: SocketHub;
const clients: Socket[] = [];

const listen = async (server: HttpServer): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const connect = async (baseUrl: string): Promise<Socket> => {
  const client = socketClient(baseUrl, { path: '/ws/workflows', auth: { token: 'good' } });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', reject);
  });
  return client;
};

let firstUrl: string;
let secondUrl: string;

beforeAll(async () => {
  first = createServer();
  second = createServer();
  firstUrl = await listen(first);
  secondUrl = await listen(second);
  hub = attachSocketHub([first, second], { identity, bus });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await hub?.close();
  await new Promise<void>((resolve) => first.close(() => resolve()));
  await new Promise<void>((resolve) => second.close(() => resolve()));
});

describe('a hub attached to every binding', () => {
  it('serves a client on either address from one set of rooms', async () => {
    const a = await connect(firstUrl);
    const b = await connect(secondUrl);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.on('workflow-event', (e) => seenA.push(e));
    b.on('workflow-event', (e) => seenB.push(e));
    a.emit('join', { room: 'workflow:wf1' });
    b.emit('join', { room: 'workflow:wf1' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    bus.emit({ name: 'workflow.node.started', tenantId: 't1', workflowId: 'wf1' } as never);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The second binding is the one that used to be dark.
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
  });

  it('upgrades to a real websocket on EVERY binding, not just the first', async () => {
    // The failure this pins is subtle and was found only by driving the live
    // product: sharing one Socket.IO instance across both servers let the
    // second address complete a handshake and then silently stay on
    // long-polling, because io.attach() replaces the engine rather than adding
    // to it. "Connected" was true and wrong.
    const a = await connect(firstUrl);
    const b = await connect(secondUrl);
    const upgraded = async (socket: Socket): Promise<string> => {
      for (let i = 0; i < 40 && socket.io.engine.transport.name !== 'websocket'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return socket.io.engine.transport.name;
    };
    expect(await upgraded(a)).toBe('websocket');
    expect(await upgraded(b)).toBe('websocket');
  });

  it('still refuses a bad token on the second binding', async () => {
    const bad = socketClient(secondUrl, { path: '/ws/workflows', auth: { token: 'nope' } });
    clients.push(bad);
    const error = await new Promise<Error>((resolve) => bad.on('connect_error', resolve));
    expect(error.message).toBe('unauthorised');
  });
});
