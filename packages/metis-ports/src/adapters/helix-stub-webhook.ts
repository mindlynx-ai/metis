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
 * The `cap.webhook` relay, stubbed. The stub IS the contract (the WP14 rule),
 * so the Helix-side service later implements exactly these five surfaces and
 * the poller in this repo never learns the difference.
 *
 * THE SHAPE, and why it is this one. An instance behind a home router or a
 * corporate firewall has no inbound route - which is the entire reason this
 * capability exists - so the relay CANNOT push a delivery to it. The instance
 * opens the connection instead and the delivery travels back down it: a long
 * poll, over the same outbound HTTP the gateway client already uses. No new
 * transport, no new port, and it works through anything that already lets
 * Metis reach the internet.
 *
 * TWO RULES THE REAL SERVICE MUST KEEP, both encoded here:
 *
 * 1. Answer the PROVIDER immediately and hold the payload. If the relay waited
 *    for the instance, a laptop that is asleep would look to Stripe like a
 *    broken endpoint and get disabled - turning "your webhook is unreachable"
 *    into "your webhook is switched off", which is worse than the problem the
 *    capability solves.
 * 2. Pass the provider's headers through UNTOUCHED. Signature verification
 *    stays on the instance, against the provider's own secret, which the relay
 *    never holds. The cloud must not be a place where a payload could be
 *    altered undetectably.
 *
 * The relay signs what it relays with its own per-endpoint secret, so the
 * instance can tell a genuine relayed delivery from anything else that reaches
 * its ingress. That is a SECOND signature, beside the provider's, not instead
 * of it.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** One delivery held for an instance that has not collected it yet. */
export interface RelayDelivery {
  id: string;
  endpointId: string;
  receivedAt: string;
  /** The provider's headers, exactly as they arrived. */
  headers: Record<string, string>;
  /** The raw body, unparsed: a signature is over bytes, not over a re-encoding. */
  body: string;
  /** The RELAY's signature over this delivery, keyed by the endpoint secret. */
  signature: string;
}

interface Endpoint {
  endpointId: string;
  triggerId: string;
  secret: string;
  email: string;
}

export interface RelayStub {
  /** Handle a relay request; false when the path is not ours. */
  handle(request: IncomingMessage, response: ServerResponse, path: string): boolean;
  /** Deliveries not yet acknowledged, oldest first (test assertions). */
  pending(): RelayDelivery[];
  /** Endpoints currently claimed (test assertions). */
  endpoints(): Endpoint[];
}

export interface RelayStubOptions {
  /** The stub's own base URL, so a claimed endpoint can state a real one. */
  baseUrl: () => string;
  /** Is this bearer allowed cap.webhook? */
  entitled: (request: IncomingMessage) => { email: string } | 'unauthorised' | 'unentitled';
  json: (response: ServerResponse, status: number, body: unknown) => void;
  /**
   * How long a poll waits before answering empty. Zero answers at once, which
   * is what the tests want; the real service holds the connection.
   */
  pollHoldMs?: number;
}

/** The relay's signature over one delivery: id, timestamp and body. */
export function signDelivery(secret: string, id: string, receivedAt: string, body: string): string {
  return createHmac('sha256', secret).update(`${id}.${receivedAt}.${body}`).digest('base64');
}

export function createRelayStub(options: RelayStubOptions): RelayStub {
  const endpoints = new Map<string, Endpoint>();
  // Ordered, because a poll answers "everything after this cursor" and the
  // cursor is a position in this list.
  const queue: RelayDelivery[] = [];

  const readBody = (request: IncomingMessage, then: (body: string) => void): void => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => then(body));
  };

  const headersOf = (request: IncomingMessage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') out[name] = value;
      else if (Array.isArray(value)) out[name] = value.join(', ');
    }
    return out;
  };

  const claim = (request: IncomingMessage, response: ServerResponse): void => {
    const account = options.entitled(request);
    if (account === 'unauthorised') return options.json(response, 401, { error: 'unauthorised' });
    if (account === 'unentitled') return options.json(response, 403, { error: 'unentitled' });
    readBody(request, (raw) => {
      const body = raw === '' ? {} : (JSON.parse(raw) as { triggerId?: string });
      if (!body.triggerId) return options.json(response, 400, { error: 'triggerId is required' });
      // One address per trigger: claiming twice returns the SAME endpoint, so a
      // restart re-claims rather than orphaning the address a provider already
      // has. The real service must do this too.
      const existing = [...endpoints.values()].find((entry) => entry.triggerId === body.triggerId);
      const endpoint: Endpoint = existing ?? {
        endpointId: `wep_${randomUUID()}`,
        triggerId: body.triggerId,
        secret: `whsec_${randomUUID()}`,
        email: account.email,
      };
      endpoints.set(endpoint.endpointId, endpoint);
      options.json(response, 200, {
        endpointId: endpoint.endpointId,
        url: `${options.baseUrl()}/relay/${endpoint.endpointId}`,
        secret: endpoint.secret,
      });
    });
  };

  /** A provider posting to the public address. Unauthenticated, by definition. */
  const receive = (request: IncomingMessage, response: ServerResponse, endpointId: string): void => {
    const endpoint = endpoints.get(endpointId);
    if (!endpoint) return options.json(response, 404, { error: 'no such endpoint' });
    readBody(request, (body) => {
      const id = `whd_${randomUUID()}`;
      const receivedAt = new Date().toISOString();
      queue.push({
        id,
        endpointId,
        receivedAt,
        headers: headersOf(request),
        body,
        signature: signDelivery(endpoint.secret, id, receivedAt, body),
      });
      // Immediately, and before anyone has collected it. See rule 1 above.
      options.json(response, 202, { received: true });
    });
  };

  const poll = (request: IncomingMessage, response: ServerResponse, after: string | null): void => {
    const account = options.entitled(request);
    if (account === 'unauthorised') return options.json(response, 401, { error: 'unauthorised' });
    if (account === 'unentitled') return options.json(response, 403, { error: 'unentitled' });
    const from = after ? queue.findIndex((delivery) => delivery.id === after) + 1 : 0;
    const deliveries = queue.slice(from < 0 ? 0 : from);
    const answer = (): void =>
      options.json(response, 200, {
        deliveries,
        cursor: deliveries.length > 0 ? deliveries[deliveries.length - 1].id : after,
      });
    if (deliveries.length > 0 || !options.pollHoldMs) return answer();
    // unref'd: a held poll must never be the reason a test process stays alive.
    setTimeout(answer, options.pollHoldMs).unref();
  };

  const ack = (request: IncomingMessage, response: ServerResponse, id: string): void => {
    const account = options.entitled(request);
    if (account === 'unauthorised') return options.json(response, 401, { error: 'unauthorised' });
    const index = queue.findIndex((delivery) => delivery.id === id);
    if (index < 0) return options.json(response, 404, { error: 'no such delivery' });
    queue.splice(index, 1);
    options.json(response, 204, {});
  };

  const release = (request: IncomingMessage, response: ServerResponse, endpointId: string): void => {
    const account = options.entitled(request);
    if (account === 'unauthorised') return options.json(response, 401, { error: 'unauthorised' });
    if (!endpoints.delete(endpointId)) return options.json(response, 404, { error: 'no such endpoint' });
    // The address stops working the moment it is released: a URL that outlives
    // its trigger is one nobody is watching.
    options.json(response, 204, {});
  };

  return {
    handle(request, response, path) {
      if (request.method === 'POST' && path === '/v1/capabilities/webhook/endpoints') {
        claim(request, response);
        return true;
      }
      const receiveMatch = /^\/relay\/([^/]+)$/.exec(path);
      if (request.method === 'POST' && receiveMatch) {
        receive(request, response, receiveMatch[1]);
        return true;
      }
      if (request.method === 'GET' && path === '/v1/capabilities/webhook/deliveries') {
        const after = new URL(request.url ?? '/', 'https://stub.invalid').searchParams.get('after');
        poll(request, response, after);
        return true;
      }
      const ackMatch = /^\/v1\/capabilities\/webhook\/deliveries\/([^/]+)\/ack$/.exec(path);
      if (request.method === 'POST' && ackMatch) {
        ack(request, response, ackMatch[1]);
        return true;
      }
      const releaseMatch = /^\/v1\/capabilities\/webhook\/endpoints\/([^/]+)$/.exec(path);
      if (request.method === 'DELETE' && releaseMatch) {
        release(request, response, releaseMatch[1]);
        return true;
      }
      return false;
    },
    pending: () => [...queue],
    endpoints: () => [...endpoints.values()],
  };
}
