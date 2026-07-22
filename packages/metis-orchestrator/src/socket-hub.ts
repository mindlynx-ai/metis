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

export function attachSocketHub(server: HttpServer, options: SocketHubOptions): SocketHub {
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
