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

/** Verify an inbound webhook body against the trigger's scheme + secret. */
export function verifyTriggerSignature(
  trigger: Pick<TriggerRecord, 'verification' | 'secret'>,
  rawBody: string,
  headers: HeaderBag,
): boolean {
  const scheme = trigger.verification ?? 'hmac';
  if (scheme === 'none') return true;
  const secret = trigger.secret ?? '';
  if (!secret) return false;
  if (scheme === 'github') {
    const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    return safeEqual(`sha256=${digest}`, header(headers, 'x-hub-signature-256'));
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
    header(headers, 'x-github-delivery') || header(headers, 'x-metis-delivery') || undefined;
  const event = header(headers, 'x-github-event') || trigger.event;
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
  error?: string;
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
  const executionId = deps.newExecutionId();
  await deps.executions.start({
    tenantId: deps.tenantId,
    workflowId: trigger.workflowId,
    executionId,
    workflowType: 'helixWorkflow',
    definition: published.definition as unknown as WorkflowDefinition,
    input: normaliseEnvelope(trigger, args.headers, body, deps.now()),
  } as never);
  return { status: 202, executionId };
}
