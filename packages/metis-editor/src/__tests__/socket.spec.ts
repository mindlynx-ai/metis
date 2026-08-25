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
 * The shared socket, against a real socket.io server.
 *
 * Driven for real rather than mocked, because the bug being fixed was
 * specifically that socket.io does NOT share a connection the way the old code
 * assumed. A mock would have agreed with the old code.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import type { AddressInfo } from 'node:net';

const tokens: string[] = [];
const joined: string[] = [];
const left: string[] = [];
let connections = 0;

vi.mock('../api.js', () => ({ getToken: () => 'test-token' }));

let http: HttpServer;
let io: SocketServer;
let socketModule: typeof import('../socket.js');

beforeAll(async () => {
  http = createServer();
  io = new SocketServer(http, { path: '/ws/workflows', cors: { origin: true } });
  io.on('connection', (socket) => {
    connections += 1;
    tokens.push(String(socket.handshake.auth?.token ?? ''));
    socket.on('join', (p: { room?: string }) => {
      joined.push(String(p?.room));
      socket.join(String(p?.room));
    });
    socket.on('leave', (p: { room?: string }) => {
      left.push(String(p?.room));
      socket.leave(String(p?.room));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  // The module builds a same-origin socket; in node there is no origin, so point
  // socket.io at the test server the same way a browser would resolve it.
  // socket.io-client resolves a URL-less io() against `location`, exactly as a
  // browser would. Stubbing it is what lets the real client talk to the test
  // server without the module needing a test-only parameter.
  vi.stubGlobal('location', {
    origin: `http://127.0.0.1:${port}`,
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: String(port),
    host: `127.0.0.1:${port}`,
  });
  socketModule = await import('../socket.js');
});

afterEach(() => {
  socketModule.resetSocket();
  joined.length = 0;
  left.length = 0;
  tokens.length = 0;
  connections = 0;
});

afterAll(async () => {
  socketModule.resetSocket();
  await io.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('the shared socket', () => {
  it('opens ONE connection no matter how many rooms are watched', async () => {
    const a = socketModule.joinRoom('workflow:one');
    const b = socketModule.joinRoom('workflow:two');
    const c = socketModule.joinRoom('tenant:t1:workflows');
    await settle();

    // The whole point. Three io() calls used to mean three sockets.
    expect(connections).toBe(1);
    expect(joined.sort()).toEqual(['tenant:t1:workflows', 'workflow:one', 'workflow:two']);
    a();
    b();
    c();
  });

  it('sends the token from the store on connect', async () => {
    const release = socketModule.joinRoom('workflow:tok');
    await settle();
    expect(tokens).toEqual(['test-token']);
    release();
  });

  it('keeps a room while anyone still wants it, and leaves once', async () => {
    const first = socketModule.joinRoom('workflow:shared');
    const second = socketModule.joinRoom('workflow:shared');
    await settle();
    // Two watchers, one join: the server should not see a duplicate.
    expect(joined.filter((r) => r === 'workflow:shared')).toHaveLength(1);

    first();
    await settle();
    expect(left).not.toContain('workflow:shared');

    second();
    await settle();
    expect(left).toEqual(['workflow:shared']);
  });

  it('ignores a release called twice', async () => {
    const release = socketModule.joinRoom('workflow:twice');
    await settle();
    release();
    release();
    await settle();
    // A second release must not drive the count negative and leave a live room.
    expect(left.filter((r) => r === 'workflow:twice')).toHaveLength(1);
  });

  it('delivers engine events to a listener and stops on unsubscribe', async () => {
    const seen: unknown[] = [];
    const release = socketModule.joinRoom('workflow:evt');
    const off = socketModule.onWorkflowEvent((event) => seen.push(event));
    await settle();

    io.to('workflow:evt').emit('workflow-event', { name: 'workflow.node.started', nodeId: 'n1' });
    await settle();
    expect(seen).toHaveLength(1);

    off();
    io.to('workflow:evt').emit('workflow-event', { name: 'workflow.node.completed' });
    await settle();
    expect(seen).toHaveLength(1);
    release();
  });
});
