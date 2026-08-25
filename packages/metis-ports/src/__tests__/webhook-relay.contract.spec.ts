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
 * Contract tests for `cap.webhook`: the relay client against the stub. The stub
 * IS the contract, so what these lock is what the Helix-side service must do.
 *
 * The two rules that matter most are the least obvious, and both are asserted
 * here: the relay answers the PROVIDER before anyone has collected the
 * delivery, and it passes the provider's headers through untouched so the
 * provider's own signature still verifies on the instance.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { UnentitledError, WebhookRelayClient } from '../uplift.js';
import { signDelivery } from '../adapters/helix-stub-webhook.js';
import { startHelixStub, type HelixStub } from '../adapters/helix-stub.js';

let stub: HelixStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

const clientFor = (entitled: string[] = ['cap.webhook']) => async () => {
  stub = await startHelixStub({ entitled });
  const token = stub.issueToken();
  return new WebhookRelayClient({ baseUrl: stub.url, getBearer: () => Promise.resolve(token) });
};

/** A provider posting to the public address. No auth: that is the point of it. */
const providerPost = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('the cap.webhook relay contract', () => {
  it('claims a public address for a trigger, and re-claiming returns the same one', async () => {
    const client = await clientFor()();
    const first = await client.claim('trg_1');
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/relay\/wep_/);
    expect(first.secret).toMatch(/^whsec_/);
    // A restart must re-claim, not orphan the address a provider already holds.
    const again = await client.claim('trg_1');
    expect(again.endpointId).toBe(first.endpointId);
    expect(again.url).toBe(first.url);
    // A different trigger is a different address.
    expect((await client.claim('trg_2')).endpointId).not.toBe(first.endpointId);
  });

  it('answers the provider immediately, BEFORE the instance has collected it', async () => {
    // If the relay waited for the instance, a laptop that is asleep would look
    // to Stripe like a broken endpoint and get switched off - which is worse
    // than the unreachability this capability exists to solve.
    const client = await clientFor()();
    const endpoint = await client.claim('trg_sleepy');
    const response = await providerPost(endpoint.url, '{"id":"evt_1"}');
    expect(response.status).toBe(202);
    // Nothing has polled yet, and the delivery is already held.
    expect(stub?.relay.pending()).toHaveLength(1);
  });

  it('hands the delivery over with the provider headers untouched', async () => {
    const client = await clientFor()();
    const endpoint = await client.claim('trg_gh');
    const body = '{"action":"opened"}';
    // A real GitHub signature, made with the PROVIDER's secret - which the
    // relay never holds.
    const providerSecret = 'the-providers-own-secret';
    const providerSig = `sha256=${createHmac('sha256', providerSecret).update(body).digest('hex')}`;
    await providerPost(endpoint.url, body, { 'x-hub-signature-256': providerSig });

    const { deliveries } = await client.deliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].body).toBe(body);
    expect(deliveries[0].headers['x-hub-signature-256']).toBe(providerSig);
    // The whole point: it still verifies on this side, so the cloud can never
    // alter a payload without the instance noticing.
    const recomputed = `sha256=${createHmac('sha256', providerSecret).update(deliveries[0].body).digest('hex')}`;
    expect(recomputed).toBe(providerSig);
  });

  it('signs what it relays, so a forged delivery to the ingress is detectable', async () => {
    const client = await clientFor()();
    const endpoint = await client.claim('trg_signed');
    await providerPost(endpoint.url, '{"n":1}');
    const { deliveries } = await client.deliveries();
    const delivery = deliveries[0];
    expect(delivery.signature).toBe(
      signDelivery(endpoint.secret, delivery.id, delivery.receivedAt, delivery.body),
    );
    // A different secret does not produce it.
    expect(delivery.signature).not.toBe(
      signDelivery('whsec_someone-else', delivery.id, delivery.receivedAt, delivery.body),
    );
  });

  it('returns deliveries after a cursor, so nothing is collected twice', async () => {
    const client = await clientFor()();
    const endpoint = await client.claim('trg_cursor');
    await providerPost(endpoint.url, '{"n":1}');
    await providerPost(endpoint.url, '{"n":2}');

    const first = await client.deliveries();
    expect(first.deliveries.map((d) => d.body)).toEqual(['{"n":1}', '{"n":2}']);

    // Nothing new: the same cursor answers empty rather than replaying.
    expect((await client.deliveries(first.cursor)).deliveries).toEqual([]);

    await providerPost(endpoint.url, '{"n":3}');
    const next = await client.deliveries(first.cursor);
    expect(next.deliveries.map((d) => d.body)).toEqual(['{"n":3}']);
  });

  it('keeps holding a delivery until it is acknowledged', async () => {
    // At-least-once: an instance that crashes mid-run must get it again, so
    // collecting is not the same as being done with it.
    const client = await clientFor()();
    const endpoint = await client.claim('trg_ack');
    await providerPost(endpoint.url, '{"n":1}');
    const { deliveries } = await client.deliveries();
    expect(stub?.relay.pending()).toHaveLength(1);
    await client.ack(deliveries[0].id);
    expect(stub?.relay.pending()).toHaveLength(0);
  });

  it('stops answering the moment the address is released', async () => {
    const client = await clientFor()();
    const endpoint = await client.claim('trg_gone');
    await client.release(endpoint.endpointId);
    expect(stub?.relay.endpoints()).toHaveLength(0);
    // A URL that outlives its trigger is one nobody is watching.
    expect((await providerPost(endpoint.url, '{}')).status).toBe(404);
  });

  it('refuses an account without the capability, and says which offer it needs', async () => {
    const client = await clientFor(['cap.data'])();
    await expect(client.claim('trg_nope')).rejects.toBeInstanceOf(UnentitledError);
  });

  it('answers an empty poll rather than hanging for ever', async () => {
    stub = await startHelixStub({ entitled: ['cap.webhook'], relayPollHoldMs: 20 });
    const token = stub.issueToken();
    const client = new WebhookRelayClient({ baseUrl: stub.url, getBearer: () => Promise.resolve(token) });
    await client.claim('trg_quiet');
    const answered = await client.deliveries();
    expect(answered.deliveries).toEqual([]);
  });
});
