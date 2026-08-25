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
 * One socket for the whole tab.
 *
 * Three pages each called `io()` in their own effect, so the browser opened a
 * fresh WebSocket per page and tore it down again on any dependency change -
 * including a run starting, which is exactly when the live feed matters. A
 * tester watched three sockets appear and none of them survive.
 *
 * Multiplexing does not save you here, which is worth writing down: socket.io's
 * `lookup()` caches a Manager per origin+path, but from the SECOND call on, the
 * namespace is already in that Manager's `nsps`, so `sameNamespace` is true and
 * it builds a brand-new Manager and a brand-new transport anyway. Calling `io()`
 * per component is guaranteed churn, not sharing.
 *
 * So the socket is a module singleton and components only say which rooms they
 * care about. Rooms are ref-counted: two pages watching the same workflow share
 * one membership, and the room is left when the last of them goes.
 *
 * The token is read at CONNECT time rather than captured once, because a
 * captured token cannot survive a session refresh - socket.io would retry
 * forever with the credential that was already rejected.
 */
import { io, type Socket } from 'socket.io-client';
import { getToken } from './api.js';

/** Everything the engine streams. Rooms decide which of it reaches you. */
export interface WorkflowLiveEvent {
  name: string;
  tenantId?: string;
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

const SOCKET_PATH = '/ws/workflows';

let socket: Socket | undefined;
/** How many live subscribers each room has. Zero means leave it. */
const rooms = new Map<string, number>();

/**
 * The shared socket, connected on first use.
 *
 * Transports are deliberately NOT pinned to websocket. They were, and that made
 * every upgrade failure terminal: no fallback, a dead connection and a console
 * error with no bytes transferred. The server offers polling too, so let the
 * client negotiate and degrade instead of failing shut.
 */
function ensureSocket(): Socket {
  if (socket) return socket;
  const created = io({ path: SOCKET_PATH, auth: (cb) => cb({ token: getToken() ?? '' }) });
  // Rejoin on every (re)connect. A reconnect is a NEW server-side socket with
  // no memory of its rooms, so without this the feed goes quiet after any blip
  // while still looking connected.
  created.on('connect', () => {
    for (const room of rooms.keys()) created.emit('join', { room });
  });
  socket = created;
  return created;
}

/**
 * Watch a room until the returned function is called.
 *
 * @param room - `workflow:<id>`, `execution:<id>` or `tenant:<id>:workflows`.
 * @returns an unsubscribe, safe to call twice.
 */
export function joinRoom(room: string): () => void {
  const live = ensureSocket();
  const count = rooms.get(room) ?? 0;
  rooms.set(room, count + 1);
  if (count === 0 && live.connected) live.emit('join', { room });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (rooms.get(room) ?? 1) - 1;
    if (remaining > 0) {
      rooms.set(room, remaining);
      return;
    }
    rooms.delete(room);
    if (live.connected) live.emit('leave', { room });
  };
}

/**
 * Listen for engine events. Returns an unsubscribe.
 *
 * Every subscriber hears every event the socket receives, so callers filter on
 * what they asked for rather than assuming rooms did it for them - two pages
 * can be joined to different rooms over the same connection.
 */
export function onWorkflowEvent(handler: (event: WorkflowLiveEvent) => void): () => void {
  const live = ensureSocket();
  live.on('workflow-event', handler);
  return () => {
    live.off('workflow-event', handler);
  };
}

/**
 * Drop the connection and forget every room. For sign-out: the next sign-in
 * must not inherit a socket authenticated as the previous person.
 */
export function resetSocket(): void {
  rooms.clear();
  socket?.close();
  socket = undefined;
}
