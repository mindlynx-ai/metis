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
 * Outbound signed webhooks: the mirror of the inbound side. A
 * registered subscription receives an HMAC-signed POST for every
 * workflow lifecycle event it matches, straight off the local event
 * bus. The signature is the same generic scheme the inbound guard
 * verifies (base64 HMAC-SHA256 in x-metis-signature), so a Metis
 * receiver validates a Metis sender out of the box.
 *
 * Delivery is a bounded retry with backoff (Metis is local-first; a
 * managed deployment swaps in a durable delivery queue). The destination
 * is operator-registered, so egress there is the trust decision, exactly
 * as with connectors.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { TableDefinition, WorkflowEvent, LocalEventBus } from '@mindlynx/metis-ports';
import type { DataGateway } from '@mindlynx/metis-data-gateway';

export const OUTBOUND_WEBHOOKS_TABLE: TableDefinition = {
  name: 'outbound_webhooks',
  partitionAttribute: 'PK',
  sortAttribute: 'SK',
};

export function registerOutboundWebhookTable(gateway: DataGateway): void {
  gateway.registerDefinition(OUTBOUND_WEBHOOKS_TABLE);
}

export interface OutboundWebhookRecord {
  webhookId: string;
  tenantId: string;
  url: string;
  /** Event names to send, or ['*'] for every lifecycle event. */
  events: string[];
  secret?: string;
  enabled: boolean;
  /** Optional filter: only events from this workflow. */
  workflowId?: string;
}

export type OutboundWebhookInput = Omit<OutboundWebhookRecord, 'tenantId' | 'webhookId' | 'enabled'> &
  Partial<Pick<OutboundWebhookRecord, 'webhookId' | 'enabled'>>;

export interface OutboundPayload {
  id: string;
  event: string;
  tenantId: string;
  executionId?: string;
  workflowId?: string;
  nodeId?: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type DeliverFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

export interface DeliveryOptions {
  deliver?: DeliverFn;
  idFactory?: () => string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  backoffMs?: number;
  log?: (line: string) => void;
}

export interface DeliveryResult {
  webhookId: string;
  url: string;
  delivered: boolean;
  status?: number;
  attempts: number;
  error?: string;
}

const pk = (tenantId: string) => `OWH#${tenantId}`;

/** Base64 HMAC-SHA256 of the body, matching the inbound generic scheme. */
export function signOutbound(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

export function outboundHeaders(
  record: Pick<OutboundWebhookRecord, 'secret'>,
  body: string,
  meta: { deliveryId: string; event: string; timestamp: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-metis-event': meta.event,
    'x-metis-delivery': meta.deliveryId,
    'x-metis-timestamp': meta.timestamp,
  };
  if (record.secret) headers['x-metis-signature'] = signOutbound(record.secret, body);
  return headers;
}

/** True if the subscription should receive this event. */
export function matchesEvent(record: OutboundWebhookRecord, event: WorkflowEvent): boolean {
  if (!record.enabled) return false;
  if (record.workflowId && record.workflowId !== event.workflowId) return false;
  return record.events.includes('*') || record.events.includes(event.name);
}

export class OutboundWebhookService {
  private unsubscribe: (() => void) | undefined;
  private readonly idFactory: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(
    private readonly gateway: DataGateway,
    private readonly tenantId: string,
    private readonly options: DeliveryOptions = {},
  ) {
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 200;
  }

  async register(input: OutboundWebhookInput): Promise<OutboundWebhookRecord> {
    const record: OutboundWebhookRecord = {
      ...input,
      webhookId: input.webhookId ?? `owh_${randomUUID()}`,
      tenantId: this.tenantId,
      enabled: input.enabled ?? true,
    };
    await this.put(record);
    return record;
  }

  async get(webhookId: string): Promise<OutboundWebhookRecord | undefined> {
    const item = await this.gateway.read(OUTBOUND_WEBHOOKS_TABLE.name, {
      partitionKey: pk(this.tenantId),
      sortKey: webhookId,
    });
    return item as OutboundWebhookRecord | undefined;
  }

  async list(): Promise<OutboundWebhookRecord[]> {
    const page = await this.gateway.query({
      table: OUTBOUND_WEBHOOKS_TABLE.name,
      partitionValue: pk(this.tenantId),
    });
    return page.items as unknown as OutboundWebhookRecord[];
  }

  async remove(webhookId: string): Promise<void> {
    await this.gateway.remove(OUTBOUND_WEBHOOKS_TABLE.name, {
      partitionKey: pk(this.tenantId),
      sortKey: webhookId,
    });
  }

  async setEnabled(webhookId: string, enabled: boolean): Promise<void> {
    const record = await this.get(webhookId);
    if (!record) return;
    await this.put({ ...record, enabled });
  }

  /** Subscribe to the bus; each event is dispatched to matching subscriptions. */
  init(bus: LocalEventBus): void {
    this.unsubscribe = bus.subscribe((event) => {
      this.dispatch(event).catch(() => undefined);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Deliver one event to every matching, enabled subscription. */
  async dispatch(event: WorkflowEvent): Promise<DeliveryResult[]> {
    if (event.tenantId !== this.tenantId) return [];
    const subscriptions = (await this.list()).filter((record) => matchesEvent(record, event));
    const results: DeliveryResult[] = [];
    for (const subscription of subscriptions) {
      results.push(await this.deliverWithRetry(subscription, event));
    }
    return results;
  }

  private async deliverWithRetry(
    record: OutboundWebhookRecord,
    event: WorkflowEvent,
  ): Promise<DeliveryResult> {
    const deliver = this.options.deliver;
    if (!deliver) return { webhookId: record.webhookId, url: record.url, delivered: false, attempts: 0, error: 'no delivery transport' };
    const deliveryId = this.idFactory();
    const payload: OutboundPayload = {
      id: deliveryId,
      event: event.name,
      tenantId: event.tenantId,
      executionId: event.executionId,
      workflowId: event.workflowId,
      nodeId: event.nodeId,
      timestamp: event.timestamp,
      data: event.payload ?? {},
    };
    const body = JSON.stringify(payload);
    const headers = outboundHeaders(record, body, { deliveryId, event: event.name, timestamp: event.timestamp });

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await deliver(record.url, body, headers);
        if (response.status >= 200 && response.status < 300) {
          return { webhookId: record.webhookId, url: record.url, delivered: true, status: response.status, attempts: attempt };
        }
        lastError = `status ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < this.maxAttempts) await this.sleep(this.backoffMs * attempt);
    }
    this.options.log?.(`webhook ${record.webhookId} failed after ${this.maxAttempts} attempts: ${lastError}`);
    return { webhookId: record.webhookId, url: record.url, delivered: false, attempts: this.maxAttempts, error: lastError };
  }

  private async put(record: OutboundWebhookRecord): Promise<void> {
    await this.gateway.upsert(OUTBOUND_WEBHOOKS_TABLE.name, {
      ...record,
      PK: pk(this.tenantId),
      SK: record.webhookId,
    });
  }
}
