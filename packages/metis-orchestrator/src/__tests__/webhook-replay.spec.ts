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
 * Replay protection on the generic HMAC scheme, in both directions.
 *
 * Signing the body alone says a delivery is genuine but never says WHEN, so a
 * captured one stays valid for as long as the secret does. The delivery id made
 * that worse rather than better: it decides the execution id, so it decides
 * whether a repeat is recognised as a repeat - and it rode in an unsigned
 * header, which means editing one header was enough to have a captured request
 * run again as a brand-new run under a signature that still checked out.
 *
 * The scheme now signs `deliveryId.timestamp.body`, the same construction the
 * Svix path has always used, and holds the timestamp to the same window.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyTriggerSignature } from '../webhook-ingress.js';
import { outboundHeaders } from '../outbound-webhooks.js';

const SECRET = 'shared-secret';
const BODY = '{"order":4242}';
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);
const SECONDS = Math.floor(NOW / 1000);

const trigger = { verification: 'hmac' as const, secret: SECRET };

/** The scheme as a sender implements it from the docs. */
const sign = (deliveryId: string, timestamp: string | number, body = BODY) =>
  createHmac('sha256', SECRET).update(`${deliveryId}.${timestamp}.${body}`, 'utf8').digest('base64');

const headers = (deliveryId: string, timestamp: string | number, body = BODY) => ({
  'x-metis-delivery': deliveryId,
  'x-metis-timestamp': String(timestamp),
  'x-metis-signature': sign(deliveryId, timestamp, body),
});

describe('inbound: the generic HMAC scheme binds the delivery id and the time', () => {
  it('accepts a delivery signed over id, timestamp and body', () => {
    expect(verifyTriggerSignature(trigger, BODY, headers('dlv-1', SECONDS), NOW)).toBe(true);
  });

  it('refuses a signature over the body alone, the scheme that had no window', () => {
    const legacy = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('base64');
    expect(
      verifyTriggerSignature(trigger, BODY, { 'x-metis-signature': legacy }, NOW),
    ).toBe(false);
    // ...including when the sender does supply a timestamp it did not sign.
    expect(
      verifyTriggerSignature(
        trigger,
        BODY,
        { 'x-metis-signature': legacy, 'x-metis-timestamp': String(SECONDS), 'x-metis-delivery': 'dlv-1' },
        NOW,
      ),
    ).toBe(false);
  });

  it('refuses a captured delivery replayed after the window', () => {
    const captured = headers('dlv-1', SECONDS);
    expect(verifyTriggerSignature(trigger, BODY, captured, NOW + 299_000)).toBe(true);
    expect(verifyTriggerSignature(trigger, BODY, captured, NOW + 301_000)).toBe(false);
    // And one dated far enough ahead to outlive the window on purpose.
    expect(verifyTriggerSignature(trigger, BODY, headers('dlv-1', SECONDS + 3600), NOW)).toBe(false);
  });

  it('refuses a captured delivery re-labelled with a fresh delivery id', () => {
    const captured = headers('dlv-1', SECONDS);
    const relabelled = { ...captured, 'x-metis-delivery': 'dlv-2' };
    expect(verifyTriggerSignature(trigger, BODY, relabelled, NOW)).toBe(false);
  });

  it('refuses a delivery with no timestamp at all, and a nonsense one', () => {
    const noTimestamp: Record<string, string> = { ...headers('dlv-1', SECONDS) };
    delete noTimestamp['x-metis-timestamp'];
    expect(verifyTriggerSignature(trigger, BODY, noTimestamp, NOW)).toBe(false);
    expect(verifyTriggerSignature(trigger, BODY, headers('dlv-1', 'yesterday'), NOW)).toBe(false);
  });

  it('still refuses a tampered body and a wrong secret', () => {
    expect(verifyTriggerSignature(trigger, '{"order":9}', headers('dlv-1', SECONDS), NOW)).toBe(false);
    expect(
      verifyTriggerSignature({ verification: 'hmac', secret: 'wrong' }, BODY, headers('dlv-1', SECONDS), NOW),
    ).toBe(false);
  });
});

describe('outbound: a Metis sender signs what a Metis receiver checks', () => {
  const send = (event = 'workflow.execution.completed') =>
    outboundHeaders({ secret: SECRET }, BODY, { deliveryId: 'dlv-out', event, timestamp: String(SECONDS) });

  it('round-trips against the inbound guard', () => {
    expect(verifyTriggerSignature(trigger, BODY, send(), NOW)).toBe(true);
  });

  it('signs the timestamp it sends, so the header cannot be moved', () => {
    const moved = { ...send(), 'x-metis-timestamp': String(SECONDS + 3600) };
    expect(verifyTriggerSignature(trigger, BODY, moved, NOW)).toBe(false);
  });

  it('signs the delivery id it sends, so a receiver cannot be made to re-run', () => {
    const relabelled = { ...send(), 'x-metis-delivery': 'dlv-out-2' };
    expect(verifyTriggerSignature(trigger, BODY, relabelled, NOW)).toBe(false);
  });

  it('sends no signature at all when the subscription has no secret', () => {
    const unsigned = outboundHeaders({}, BODY, {
      deliveryId: 'd',
      event: 'e',
      timestamp: String(SECONDS),
    });
    expect(unsigned['x-metis-signature']).toBeUndefined();
  });
});
