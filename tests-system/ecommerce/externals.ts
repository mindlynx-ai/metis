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
 * The fake outside world for the e-commerce scenarios: one http server
 * standing in for the payment provider, courier, marketplaces, Slack and the
 * mail service. Every request is recorded, and each path can be scripted with
 * a queue of replies (decline, then succeed; time out twice, then succeed)
 * so error-handling and retry cases are deterministic.
 *
 * The runtime under test reaches it by hostname: `host.docker.internal` for
 * the compose stack (the documented quickstart), overridable with
 * METIS_EXTERNALS_HOST when the runtime runs on the host itself. That
 * hostname goes in the http node's allowedHosts, which short-circuits the
 * SSRF guard.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted reply. `delayMs` outlives the node's timeout to fake a hang. */
export interface Reply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

export interface Call {
  path: string;
  method: string;
  body: unknown;
  idempotencyKey?: string;
  /** The status this call was answered with (undefined if the client hung up). */
  repliedStatus?: number;
  at: number;
}

const HOST_FOR_RUNTIME = process.env.METIS_EXTERNALS_HOST ?? 'host.docker.internal';

export class Externals {
  private server?: Server;
  private port = 0;
  private scripts = new Map<string, Reply[]>();
  private recorded: Call[] = [];
  /** Bodies already answered for an idempotency key, per path. */
  private idempotent = new Map<string, unknown>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => {
      // 0.0.0.0 so a containerised runtime can reach it, not just the host.
      this.server?.listen(0, '0.0.0.0', () => resolve());
    });
    this.port = (this.server?.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /** Base URL as the RUNTIME sees it (not necessarily as this process does). */
  get baseUrl(): string {
    return `http://${HOST_FOR_RUNTIME}:${this.port}`;
  }

  /** The hostname to put in a node's allowedHosts. */
  get host(): string {
    return HOST_FOR_RUNTIME;
  }

  /** Queue replies for a path. The last one repeats once the queue drains. */
  script(path: string, replies: Reply[]): void {
    this.scripts.set(path, [...replies]);
  }

  calls(path?: string): Call[] {
    return path ? this.recorded.filter((c) => c.path === path) : [...this.recorded];
  }

  /** Calls this server actually answered 2xx: what the outside world "did". */
  succeeded(path: string): Call[] {
    return this.calls(path).filter((c) => (c.repliedStatus ?? 0) < 300 && (c.repliedStatus ?? 0) >= 200);
  }

  reset(): void {
    this.scripts.clear();
    this.recorded = [];
    this.idempotent.clear();
  }

  private nextReply(path: string): Reply {
    const queue = this.scripts.get(path);
    if (!queue || queue.length === 0) return { status: 200, body: { ok: true } };
    return queue.length === 1 ? queue[0] : (queue.shift() as Reply);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    const raw = await readBody(req);
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const idempotencyKey = header(req, 'idempotency-key');
    const call: Call = { path, method: req.method ?? 'GET', body, idempotencyKey, at: Date.now() };
    this.recorded.push(call);

    // An idempotency key replays the first answer instead of acting again.
    const memo = idempotencyKey ? `${path}:${idempotencyKey}` : undefined;
    if (memo && this.idempotent.has(memo)) {
      call.repliedStatus = 200;
      return send(res, 200, { ...(this.idempotent.get(memo) as object), replayed: true });
    }

    const reply = this.nextReply(path);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    const status = reply.status ?? 200;
    const payload = reply.body ?? { ok: status < 300 };
    if (memo && status < 300) this.idempotent.set(memo, payload);
    if (res.writableEnded || res.destroyed) return; // client gave up mid-delay
    call.repliedStatus = status;
    send(res, status, payload);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
