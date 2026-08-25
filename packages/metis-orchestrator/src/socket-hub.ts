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
 * The run-status WebSocket, a slim port of the origin
 * SocketHub: Socket.IO on /ws/workflows with execution, workflow and
 * tenant rooms. The open build feeds it from the LocalEventBus rather
 * than an internal HMAC broadcast route; the editor's execution viewer
 * subscribes to execution:{id} for live node status.
 */
import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import type { IdentityPort, LocalEventBus, WorkflowEvent } from '@mindlynx/metis-ports';

export interface SocketHubOptions {
  identity: IdentityPort;
  bus: LocalEventBus;
}

export interface SocketHub {
  close(): Promise<void>;
}

/**
 * Attach the run-status hub to one or more HTTP servers.
 *
 * More than one, because loopback is TWO addresses. Told to serve `localhost`,
 * Fastify binds ::1 as the primary and 127.0.0.1 as a secondary. Attaching to
 * the primary alone left the other stack with working HTTP and a websocket
 * upgrade Node destroyed for want of a listener - and Windows resolves
 * `localhost` to ::1 first, so that was the stack its browsers landed on.
 *
 * ONE Socket.IO server PER http server, not one shared across them. Sharing was
 * the obvious idea and it does not work: `io.attach()` replaces the instance's
 * engine, so the second call leaves the first server's upgrade handling behind
 * and the second address silently degrades to long-polling. Rooms live on the
 * connection, and every instance subscribes to the same bus, so a client gets
 * the same events whichever address it arrived on.
 */
export function attachSocketHub(
  servers: HttpServer | readonly HttpServer[],
  options: SocketHubOptions,
): SocketHub {
  const all = Array.isArray(servers) ? servers : [servers as HttpServer];
  const instances = all.map((server, index) => {
    // Fastify wires each SECONDARY binding's 'upgrade' straight to the primary
    // (fastify/lib/server.js: `secondaryServer.on('upgrade', mainServer.emit...)`)
    // so that one websocket handler on app.server can serve every address.
    //
    // That is the wrong shape here and actively breaks things. The polling
    // handshake is an ordinary HTTP request, and it is answered by the server
    // it arrived at - so each binding needs its own Socket.IO instance or
    // polling 404s there. With an instance attached AND the forwarder still in
    // place, the secondary then has two upgrade handlers racing, and the
    // connection silently settles on long-polling instead of a websocket.
    //
    // So the forwarder goes, and each binding answers for itself. Only on the
    // secondaries: the primary's listeners are its own.
    if (index > 0) server.removeAllListeners('upgrade');
    return buildServerHub(server, options);
  });
  return {
    async close() {
      await Promise.all(instances.map((instance) => instance.close()));
    },
  };
}

/** One Socket.IO server, bound to exactly one HTTP server. */
function buildServerHub(server: HttpServer, options: SocketHubOptions): SocketHub {
  const io = new SocketServer(server, {
    path: '/ws/workflows',
    cors: { origin: true },
  });

  io.use((socket, next) => {
    const token = String(socket.handshake.auth?.token ?? '');
    options.identity
      .verify(token)
      .then((session) => {
        if (!session) {
          next(new Error('unauthorised'));
          return;
        }
        socket.data.session = session;
        next();
      })
      .catch(() => next(new Error('unauthorised')));
  });

  io.on('connection', (socket) => {
    socket.on('join', (payload: { room?: string }) => {
      const room = String(payload?.room ?? '');
      if (/^(execution|workflow):[\w-]+$/.test(room) || /^tenant:[\w-]+:workflows$/.test(room)) {
        socket.join(room);
      }
    });
    socket.on('leave', (payload: { room?: string }) => {
      const room = String(payload?.room ?? '');
      socket.leave(room);
    });
  });

  const unsubscribe = options.bus.subscribe((event: WorkflowEvent) => {
    // Emit once to the set of relevant rooms so a socket joined to more
    // than one of them still receives the event a single time.
    const rooms = [`tenant:${event.tenantId}:workflows`];
    if (event.executionId) rooms.push(`execution:${event.executionId}`);
    if (event.workflowId) rooms.push(`workflow:${event.workflowId}`);
    io.to(rooms).emit('workflow-event', event);
  });

  return {
    async close() {
      unsubscribe();
      await io.close();
    },
  };
}
