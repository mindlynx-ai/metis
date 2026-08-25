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
 * The cap.webhook poller. What matters here is not that it works when
 * everything is fine, but what it does when things are not: an instance with no
 * cloud, a delivery for an endpoint it does not hold, a forged signature, a
 * workflow that refuses, and a trigger deleted while an address is claimed.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { RelayPoller, type RelayClient, type RelayedDelivery } from '../relay-poller.js';

const sign = (secret: string, id: string, receivedAt: string, body: string): string =>
  createHmac('sha256', secret).update(`${id}.${receivedAt}.${body}`).digest('base64');

const webhookTrigger = (triggerId: string, enabled = true) => ({
  triggerId,
  tenantId: 't1',
  workflowId: 'wf_1',
  kind: 'webhook' as const,
  enabled,
});

/** A relay that hands out predictable endpoints and holds what it is given. */
function fakeRelay(queue: RelayedDelivery[] = []) {
  const claimed = new Map<string, { endpointId: string; url: string; secret: string }>();
  const acked: string[] = [];
  const released: string[] = [];
  const client: RelayClient = {
    claim: (triggerId) => {
      const existing = claimed.get(triggerId);
      if (existing) return Promise.resolve(existing);
      const endpoint = {
        endpointId: `wep_${triggerId}`,
        url: `https://relay.test/relay/wep_${triggerId}`,
        secret: `secret-${triggerId}`,
      };
      claimed.set(triggerId, endpoint);
      return Promise.resolve(endpoint);
    },
    deliveries: () => Promise.resolve({ deliveries: queue.splice(0), cursor: 'c1' }),
    ack: (id) => {
      acked.push(id);
      return Promise.resolve();
    },
    release: (endpointId) => {
      released.push(endpointId);
      return Promise.resolve();
    },
  };
  return { client, claimed, acked, released };
}

const delivery = (over: Partial<RelayedDelivery> & { secret?: string }): RelayedDelivery => {
  const base = {
    id: over.id ?? 'whd_1',
    endpointId: over.endpointId ?? 'wep_trg_1',
    receivedAt: over.receivedAt ?? '2026-08-25T12:00:00.000Z',
    body: over.body ?? '{"n":1}',
  };
  return {
    ...base,
    headers: over.headers ?? { 'content-type': 'application/json' },
    signature: over.signature ?? sign(over.secret ?? 'secret-trg_1', base.id, base.receivedAt, base.body),
  };
};

describe('the cap.webhook poller', () => {
  it('does nothing at all when there is no cloud', async () => {
    // Not entitled, or not connected. The local endpoint is complete on its
    // own, so this must be silent - not an error, not a retry, nothing.
    const calls: string[] = [];
    const poller = new RelayPoller({
      triggers: { list: () => Promise.resolve([webhookTrigger('trg_1')]) } as never,
      relay: () => undefined,
      deliver: () => {
        calls.push('delivered');
        return Promise.resolve({ status: 202 });
      },
    });
    expect(await poller.pollOnce()).toEqual({ claimed: 0, delivered: 0, refused: 0, skipped: true });
    expect(calls).toEqual([]);
  });

  it('claims one address per enabled webhook trigger, and only once', async () => {
    const relay = fakeRelay();
    const poller = new RelayPoller({
      triggers: {
        list: () => Promise.resolve([webhookTrigger('trg_1'), webhookTrigger('trg_2')]),
      } as never,
      relay: () => relay.client,
      deliver: () => Promise.resolve({ status: 202 }),
    });
    expect((await poller.pollOnce()).claimed).toBe(2);
    // A second pass claims nothing new: the addresses are already held.
    expect((await poller.pollOnce()).claimed).toBe(0);
    expect(poller.endpointFor('trg_1')?.url).toBe('https://relay.test/relay/wep_trg_1');
  });

  it('ignores a schedule trigger and a disabled webhook one', async () => {
    const relay = fakeRelay();
    const poller = new RelayPoller({
      triggers: {
        list: () =>
          Promise.resolve([
            { ...webhookTrigger('trg_off'), enabled: false },
            { triggerId: 'trg_cron', tenantId: 't1', workflowId: 'wf', kind: 'schedule', enabled: true },
          ]),
      } as never,
      relay: () => relay.client,
      deliver: () => Promise.resolve({ status: 202 }),
    });
    expect((await poller.pollOnce()).claimed).toBe(0);
  });

  it('hands a genuine delivery to the same path a local POST uses', async () => {
    const relay = fakeRelay([delivery({})]);
    const seen: { triggerId: string; rawBody: string; headers: Record<string, string> }[] = [];
    const poller = new RelayPoller({
      triggers: { list: () => Promise.resolve([webhookTrigger('trg_1')]) } as never,
      relay: () => relay.client,
      deliver: (args) => {
        seen.push(args);
        return Promise.resolve({ status: 202 });
      },
    });
    const outcome = await poller.pollOnce();
    expect(outcome.delivered).toBe(1);
    expect(seen[0].triggerId).toBe('trg_1');
    expect(seen[0].rawBody).toBe('{"n":1}');
    // The provider's headers arrive untouched, so ITS signature still verifies.
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(relay.acked).toEqual(['whd_1']);
  });

  it('refuses a forged relay signature and never runs it', async () => {
    const relay = fakeRelay([delivery({ secret: 'not-the-relays-secret' })]);
    const ran: string[] = [];
    const poller = new RelayPoller({
      triggers: { list: () => Promise.resolve([webhookTrigger('trg_1')]) } as never,
      relay: () => relay.client,
      deliver: () => {
        ran.push('ran');
        return Promise.resolve({ status: 202 });
      },
    });
    const outcome = await poller.pollOnce();
    expect(ran).toEqual([]);
    expect(outcome.refused).toBe(1);
    // Acknowledged anyway: left queued it would be retried for ever.
    expect(relay.acked).toEqual(['whd_1']);
  });

  it('drops a delivery for an endpoint this instance does not hold', async () => {
    const relay = fakeRelay([delivery({ endpointId: 'wep_somebody_else' })]);
    const ran: string[] = [];
    const poller = new RelayPoller({
      triggers: { list: () => Promise.resolve([webhookTrigger('trg_1')]) } as never,
      relay: () => relay.client,
      deliver: () => {
        ran.push('ran');
        return Promise.resolve({ status: 202 });
      },
    });
    expect((await poller.pollOnce()).refused).toBe(1);
    expect(ran).toEqual([]);
  });

  it('acknowledges a delivery the workflow refused, rather than retrying for ever', async () => {
    // A bad PROVIDER signature, or an unpublished workflow: redelivering it
    // would fail identically every time.
    const relay = fakeRelay([delivery({})]);
    const poller = new RelayPoller({
      triggers: { list: () => Promise.resolve([webhookTrigger('trg_1')]) } as never,
      relay: () => relay.client,
      deliver: () => Promise.resolve({ status: 401, error: 'invalid signature' }),
    });
    const outcome = await poller.pollOnce();
    expect(outcome.delivered).toBe(0);
    expect(outcome.refused).toBe(1);
    expect(relay.acked).toEqual(['whd_1']);
  });

  it('gives the address back when its trigger is deleted', async () => {
    const relay = fakeRelay();
    let triggers = [webhookTrigger('trg_1')];
    const poller = new RelayPoller({
      triggers: { list: () => Promise.resolve(triggers) } as never,
      relay: () => relay.client,
      deliver: () => Promise.resolve({ status: 202 }),
    });
    await poller.pollOnce();
    expect(poller.endpointFor('trg_1')).toBeDefined();
    triggers = [];
    await poller.pollOnce();
    expect(poller.endpointFor('trg_1')).toBeUndefined();
    expect(relay.released).toEqual(['wep_trg_1']);
  });
});
