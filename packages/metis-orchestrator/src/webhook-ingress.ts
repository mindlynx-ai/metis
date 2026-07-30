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
 * Webhook ingress: verify an inbound webhook, normalise it to a
 * connector-agnostic envelope, and start the bound workflow. Pure and
 * transport-free so the control-server route is a thin adapter and the
 * whole path is unit-testable. Temporal is the durability: once start()
 * is accepted the run is guaranteed, so no external queue is needed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ExecutionPort } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import type { WorkflowDefinition } from '@mindlynx/metis-engine';
import type { TriggerRecord, TriggerService } from './triggers.js';

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** How long a signed delivery stays acceptable, so a captured one cannot be
 *  replayed indefinitely. Svix's own tolerance. */
const SVIX_TOLERANCE_SECONDS = 5 * 60;

/** Either spelling of the Svix headers: the standard-webhooks names and the
 *  older svix-prefixed ones. Resend sends the svix- set. */
function svixHeader(headers: HeaderBag, suffix: string): string {
  return header(headers, `svix-${suffix}`) || header(headers, `webhook-${suffix}`);
}

/**
 * Verify a Svix-signed delivery (Resend, and every other standard-webhooks
 * sender). The scheme differs from a plain HMAC in three ways that all matter:
 * the signed content is `id.timestamp.body` rather than the body alone, the
 * secret is base64 behind a `whsec_` prefix rather than raw bytes, and the
 * header carries a space-separated list of versioned signatures so a secret can
 * be rotated without dropping deliveries.
 */
function verifySvix(secret: string, rawBody: string, headers: HeaderBag, nowMs: number): boolean {
  const id = svixHeader(headers, 'id');
  const timestamp = svixHeader(headers, 'timestamp');
  const signatures = svixHeader(headers, 'signature');
  if (!id || !timestamp || !signatures) return false;

  // Reject a delivery signed too long ago (or too far ahead), so a captured
  // body cannot be replayed later.
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - sentAt) > SVIX_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
  // Any listed v1 signature may match: during a rotation the sender signs with
  // both the old and the new secret.
  return signatures
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .some((entry) => safeEqual(expected, entry.slice(3)));
}

/** Verify an inbound webhook body against the trigger's scheme + secret. */
export function verifyTriggerSignature(
  trigger: Pick<TriggerRecord, 'verification' | 'secret'>,
  rawBody: string,
  headers: HeaderBag,
  nowMs: number = Date.now(),
): boolean {
  const scheme = trigger.verification ?? 'hmac';
  if (scheme === 'none') return true;
  const secret = trigger.secret ?? '';
  if (!secret) return false;
  if (scheme === 'github') {
    const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    return safeEqual(`sha256=${digest}`, header(headers, 'x-hub-signature-256'));
  }
  if (scheme === 'svix') {
    return verifySvix(secret, rawBody, headers, nowMs);
  }
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return safeEqual(digest, header(headers, 'x-metis-signature'));
}

export interface WebhookEnvelope {
  triggerId: string;
  connectorId?: string;
  event?: string;
  receivedAt: string;
  deliveryId?: string;
  body: unknown;
}

/** Build the connector-agnostic envelope handed to the workflow as input. */
export function normaliseEnvelope(
  trigger: TriggerRecord,
  headers: HeaderBag,
  body: unknown,
  receivedAt: string,
): WebhookEnvelope {
  const deliveryId =
    header(headers, 'x-github-delivery') ||
    header(headers, 'x-metis-delivery') ||
    svixHeader(headers, 'id') ||
    undefined;
  // The event name: a header for GitHub, but Svix senders (Resend) put it in
  // the body as `type`. Without reading it a workflow could not branch on
  // email.opened versus email.clicked without digging through the payload.
  const bodyType = (body as { type?: unknown } | null)?.type;
  const event =
    header(headers, 'x-github-event') ||
    (typeof bodyType === 'string' ? bodyType : '') ||
    trigger.event;
  return { triggerId: trigger.triggerId, connectorId: trigger.connectorId, event, receivedAt, deliveryId, body };
}

export interface WebhookDeps {
  triggers: TriggerService;
  store: WorkflowStore;
  executions: ExecutionPort;
  tenantId: string;
  newExecutionId: () => string;
  now: () => string;
}

export interface WebhookArgs {
  triggerId: string;
  headers: HeaderBag;
  rawBody: string;
}

export interface WebhookResult {
  status: 202 | 400 | 401 | 404;
  executionId?: string;
  /** The delivery had already been run under this id; nothing new was started. */
  duplicate?: boolean;
  error?: string;
}

/**
 * The execution id for a delivery that carries an id of its own. Stable, so a
 * sender retrying the same delivery lands on the same Temporal workflow id and
 * is refused instead of running the graph a second time: GitHub, Stripe and
 * Resend all retry a delivery whose response was slow or non-2xx, and this
 * handler answers only after start() has round-tripped to Temporal, which on a
 * cold worker is easily past the sender's timeout.
 *
 * Namespaced by trigger (senders do not coordinate ids across endpoints) and
 * restricted to characters that are safe in both a Temporal workflow id and a
 * store sort key. The length cap is well inside Temporal's own limit.
 */
export function deliveryExecutionId(triggerId: string, deliveryId: string): string {
  return `hook_${triggerId}_${deliveryId.replace(/[^\w.-]/g, '_').slice(0, 128)}`;
}

/** Resolve, verify, normalise and start. Returns a status the route mirrors. */
export async function handleWebhook(deps: WebhookDeps, args: WebhookArgs): Promise<WebhookResult> {
  const trigger = await deps.triggers.get(args.triggerId);
  if (!trigger || trigger.kind !== 'webhook' || !trigger.enabled) {
    return { status: 404, error: 'webhook not found' };
  }
  if (!verifyTriggerSignature(trigger, args.rawBody, args.headers)) {
    return { status: 401, error: 'invalid signature' };
  }
  let body: unknown = {};
  if (args.rawBody) {
    try {
      body = JSON.parse(args.rawBody);
    } catch {
      return { status: 400, error: 'body must be JSON' };
    }
  }
  const published = await deps.store.getLatestPublished(deps.tenantId, trigger.workflowId);
  if (!published) {
    return { status: 404, error: `workflow "${trigger.workflowId}" has no published version` };
  }
  const envelope = normaliseEnvelope(trigger, args.headers, body, deps.now());
  // A sender that identifies its delivery gets at-most-once; one that does not
  // keeps the previous behaviour, because a fresh id is the only honest answer
  // when there is nothing to recognise a repeat by.
  const executionId = envelope.deliveryId
    ? deliveryExecutionId(trigger.triggerId, envelope.deliveryId)
    : deps.newExecutionId();
  const started = await deps.executions.start({
    tenantId: deps.tenantId,
    workflowId: trigger.workflowId,
    executionId,
    workflowType: 'helixWorkflow',
    definition: published.definition as unknown as WorkflowDefinition,
    input: envelope,
    rejectDuplicate: envelope.deliveryId !== undefined,
  } as never);
  // A refused duplicate is a success: the run the sender asked for exists.
  // Answering anything else would only make it retry again.
  return started.alreadyStarted
    ? { status: 202, executionId, duplicate: true }
    : { status: 202, executionId };
}
