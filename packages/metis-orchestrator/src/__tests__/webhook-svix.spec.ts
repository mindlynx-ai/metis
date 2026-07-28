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
 * Svix-signed webhooks: the scheme Resend, and every other standard-webhooks
 * sender, uses. These cases sign the way the sender does rather than the way we
 * verify, so a mistake in our own implementation cannot make the test agree
 * with itself.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normaliseEnvelope, verifyTriggerSignature } from '../webhook-ingress.js';
import type { TriggerRecord } from '../triggers.js';

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

/** Sign a body exactly as Svix does: HMAC over `id.timestamp.body`, with the
 *  base64 secret decoded to bytes, answered as a versioned list. */
function signed(body: string, options: { secret?: string; at?: number; id?: string } = {}) {
  const id = options.id ?? 'msg_2abc';
  const timestamp = String(Math.floor((options.at ?? NOW) / 1000));
  const key = Buffer.from((options.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}

const trigger = { verification: 'svix' as const, secret: SECRET };
const OPENED = JSON.stringify({
  type: 'email.opened',
  created_at: '2026-07-28T12:00:00.000Z',
  data: { email_id: '30601887-2501-480d-8929-60dee2c94857', subject: 'Your order has shipped' },
});

describe('svix webhook verification', () => {
  it('accepts a correctly signed delivery', () => {
    expect(verifyTriggerSignature(trigger, OPENED, signed(OPENED), NOW)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const headers = signed(OPENED);
    const tampered = OPENED.replace('email.opened', 'email.clicked');
    expect(verifyTriggerSignature(trigger, tampered, headers, NOW)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const headers = signed(OPENED, { secret: `whsec_${randomBytes(24).toString('base64')}` });
    expect(verifyTriggerSignature(trigger, OPENED, headers, NOW)).toBe(false);
  });

  it('rejects a replay outside the tolerance window', () => {
    // The same delivery, still perfectly signed, but six minutes old.
    const headers = signed(OPENED, { at: NOW - 6 * 60 * 1000 });
    expect(verifyTriggerSignature(trigger, OPENED, headers, NOW)).toBe(false);
    // Inside the window it is still good.
    expect(verifyTriggerSignature(trigger, OPENED, signed(OPENED, { at: NOW - 60 * 1000 }), NOW)).toBe(true);
  });

  it('rejects a delivery with the signature header missing entirely', () => {
    const rest: Record<string, string> = { ...signed(OPENED) };
    delete rest['svix-signature'];
    expect(verifyTriggerSignature(trigger, OPENED, rest, NOW)).toBe(false);
  });

  it('accepts either header spelling, and any signature in a rotation list', () => {
    const headers = signed(OPENED);
    const renamed = {
      'webhook-id': headers['svix-id'],
      'webhook-timestamp': headers['svix-timestamp'],
      // An old secret's signature alongside the current one, as during a
      // rotation: every entry carries its own version prefix.
      'webhook-signature': `v1,c29tZXRoaW5nRWxzZQ== ${headers['svix-signature']}`,
    };
    expect(verifyTriggerSignature(trigger, OPENED, renamed, NOW)).toBe(true);
  });

  it('does not fall back to the plain-hmac scheme when svix headers are absent', () => {
    // The scheme is pinned by the trigger, so a sender cannot downgrade it by
    // choosing which headers to send.
    const digest = createHmac('sha256', SECRET).update(OPENED, 'utf8').digest('base64');
    expect(verifyTriggerSignature(trigger, OPENED, { 'x-metis-signature': digest }, NOW)).toBe(false);
  });
});

describe('the envelope a Resend delivery hands the workflow', () => {
  const record = {
    triggerId: 'trg_1',
    connectorId: 'resend',
    kind: 'webhook',
    workflowId: 'wf',
    enabled: true,
    tenantId: 't1',
  } as unknown as TriggerRecord;

  it('names the event from the body, so a workflow can branch on it', () => {
    const envelope = normaliseEnvelope(record, signed(OPENED), JSON.parse(OPENED), '2026-07-28T12:00:01.000Z');
    expect(envelope.event).toBe('email.opened');
    // The delivery id makes a redelivery recognisable as the same event.
    expect(envelope.deliveryId).toBe('msg_2abc');
    expect(envelope.connectorId).toBe('resend');
  });

  it('distinguishes a click from an open', () => {
    const clicked = { type: 'email.clicked', data: { link: { url: 'https://metisflow.io/?track=ORD-1001' } } };
    const envelope = normaliseEnvelope(record, signed('{}'), clicked, '2026-07-28T12:00:02.000Z');
    expect(envelope.event).toBe('email.clicked');
  });
});
