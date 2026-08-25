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
 * The `cap.webhook` poller: collects deliveries the cloud relay is holding and
 * feeds them into the SAME `handleWebhook` a local POST goes through.
 *
 * That sameness is the design. A relayed delivery and a direct one differ only
 * in how they arrived, so everything downstream - provider signature checks,
 * idempotency, the envelope a workflow reads, the run history - is one code
 * path with one set of tests. A parallel ingress for cloud deliveries would be
 * two implementations of "start a run from a webhook", and they would drift.
 *
 * It PULLS because it must: an instance behind a router has no inbound route,
 * which is the whole reason the capability exists.
 *
 * An unentitled or disconnected instance does nothing here at all - no claim,
 * no poll, no error - because the local endpoint is complete on its own and the
 * cloud address is an addition to it.
 */
import { verifyRelaySignature } from './relay-signature.js';
import type { TriggerRecord, TriggerService } from './triggers.js';

export interface RelayEndpointRef {
  endpointId: string;
  url: string;
  secret: string;
}

export interface RelayedDelivery {
  id: string;
  endpointId: string;
  receivedAt: string;
  headers: Record<string, string>;
  body: string;
  signature: string;
}

/** Just the relay calls this needs; the client in metis-ports satisfies it. */
export interface RelayClient {
  claim(triggerId: string): Promise<RelayEndpointRef>;
  deliveries(cursor?: string): Promise<{ deliveries: RelayedDelivery[]; cursor?: string }>;
  ack(deliveryId: string): Promise<void>;
  release(endpointId: string): Promise<void>;
}

export interface RelayPollerOptions {
  triggers: Pick<TriggerService, 'list'>;
  /** Undefined when not connected or not entitled: the poller then idles. */
  relay: () => RelayClient | undefined;
  /** The same entry point the unauthenticated /hooks route calls. */
  deliver: (args: {
    triggerId: string;
    rawBody: string;
    headers: Record<string, string>;
  }) => Promise<{ status: number; error?: string }>;
  log?: (line: string) => void;
}

export interface RelayPollOutcome {
  claimed: number;
  delivered: number;
  refused: number;
  skipped: boolean;
}

export class RelayPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursor: string | undefined;
  /** triggerId -> the endpoint claimed for it, so a secret is looked up fast. */
  private readonly endpoints = new Map<string, RelayEndpointRef>();
  private running = false;

  constructor(private readonly options: RelayPollerOptions) {}

  /** The endpoint claimed for a trigger, if this instance has claimed one. */
  endpointFor(triggerId: string): RelayEndpointRef | undefined {
    return this.endpoints.get(triggerId);
  }

  /**
   * Claim an address for every enabled webhook trigger that has none, and give
   * back the address of any trigger that has gone. The relay is idempotent per
   * trigger, so a restart re-claims the SAME address rather than orphaning the
   * one a provider already holds.
   */
  private async reconcileEndpoints(relay: RelayClient): Promise<number> {
    let claimed = 0;
    const triggers = (await this.options.triggers.list()) as TriggerRecord[];
    const live = new Set<string>();
    for (const trigger of triggers) {
      if (trigger.kind !== 'webhook' || !trigger.enabled) continue;
      live.add(trigger.triggerId);
      if (this.endpoints.has(trigger.triggerId)) continue;
      this.endpoints.set(trigger.triggerId, await relay.claim(trigger.triggerId));
      claimed += 1;
    }
    for (const [triggerId, endpoint] of [...this.endpoints]) {
      if (live.has(triggerId)) continue;
      // A public URL nobody is watching is worse than no URL at all.
      this.endpoints.delete(triggerId);
      await relay.release(endpoint.endpointId).catch(() => undefined);
    }
    return claimed;
  }

  /** Run one delivery, or refuse it. Returns whether it started a run. */
  private async handOver(relay: RelayClient, delivery: RelayedDelivery): Promise<boolean> {
    const held = [...this.endpoints.entries()].find(
      ([, candidate]) => candidate.endpointId === delivery.endpointId,
    );
    // Not ours, or not genuinely from the relay: drop it AND acknowledge, or it
    // is retried for ever.
    if (!held || !verifyRelaySignature(held[1].secret, delivery)) {
      this.options.log?.(`relay: refused delivery ${delivery.id} (signature or endpoint)`);
      await relay.ack(delivery.id).catch(() => undefined);
      return false;
    }
    const result = await this.options.deliver({
      triggerId: held[0],
      rawBody: delivery.body,
      headers: delivery.headers,
    });
    // Acknowledged either way. A delivery the workflow REFUSED (a bad provider
    // signature, an unpublished workflow) is answered, not left pending:
    // redelivering it would fail identically for ever. Only a crash before this
    // line leaves it held, which is the at-least-once case worth having.
    await relay.ack(delivery.id).catch(() => undefined);
    if (result.status < 400) return true;
    this.options.log?.(`relay: ${delivery.id} refused ${result.status} ${result.error ?? ''}`);
    return false;
  }

  async pollOnce(): Promise<RelayPollOutcome> {
    const relay = this.options.relay();
    if (!relay) return { claimed: 0, delivered: 0, refused: 0, skipped: true };
    const claimed = await this.reconcileEndpoints(relay);
    const { deliveries, cursor } = await relay.deliveries(this.cursor);
    let delivered = 0;
    for (const delivery of deliveries) {
      if (await this.handOver(relay, delivery)) delivered += 1;
    }
    if (cursor) this.cursor = cursor;
    return { claimed, delivered, refused: deliveries.length - delivered, skipped: false };
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Never overlap: a slow poll must not stack a second one behind it.
      if (this.running) return;
      this.running = true;
      this.pollOnce()
        .catch((error) => this.options.log?.(`relay poll failed: ${String(error)}`))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
