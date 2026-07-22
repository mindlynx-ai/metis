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
 * The polling bridge: for connectors without webhooks, a
 * cadence poller calls a connector operation, diffs each item's cursor
 * field against the persisted cursor, and starts one workflow run per
 * new item. The cadence is a local interval (Metis is local-first;
 * Helix swaps in a managed scheduler), but the cursor is persisted and
 * the started runs are durable through Temporal, so a restart resumes
 * cleanly and never double-fires past the cursor.
 *
 * fetchItems is injected so this module stays free of a node/HTTP
 * dependency: the runtime supplies the closure that runs the connector's
 * poll operation.
 */
import type { ExecutionPort } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import type { WorkflowDefinition } from '@mindlynx/metis-engine';
import type { TriggerRecord, TriggerService } from './triggers.js';

export type FetchItems = (trigger: TriggerRecord) => Promise<unknown[]>;

export interface ConnectorPollerOptions {
  triggers: TriggerService;
  store: WorkflowStore;
  executions: ExecutionPort;
  tenantId: string;
  fetchItems: FetchItems;
  newExecutionId: () => string;
  log?: (line: string) => void;
}

export interface PollOutcome {
  triggerId: string;
  started: number;
  seeded: boolean;
  cursor?: string;
  error?: string;
}

function readPath(item: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object') return (value as Record<string, unknown>)[key];
    return undefined;
  }, item);
}

/** Order two cursor values: numeric when both parse as numbers, else lexical. */
function compareCursor(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const numeric = a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb);
  if (numeric) return na - nb;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export class ConnectorPoller {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: ConnectorPollerOptions) {}

  /** Poll a single trigger once: diff the cursor, start new runs, persist. */
  async pollOnce(trigger: TriggerRecord): Promise<PollOutcome> {
    const items = await this.options.fetchItems(trigger);
    const field = trigger.cursorField;
    const valueOf = (item: unknown): string =>
      field ? String(readPath(item, field) ?? '') : '';

    // First run with a cursor field: establish the high-water mark, fire
    // nothing (never flood on the historical backlog).
    if (field && trigger.cursor === undefined) {
      const max = items.map(valueOf).sort(compareCursor).at(-1);
      if (max !== undefined) await this.options.triggers.setCursor(trigger.triggerId, max);
      return { triggerId: trigger.triggerId, started: 0, seeded: true, cursor: max };
    }

    const fresh = field
      ? items
          .filter((item) => compareCursor(valueOf(item), trigger.cursor ?? '') > 0)
          .sort((left, right) => compareCursor(valueOf(left), valueOf(right)))
      : items;

    const published = await this.options.store.getLatestPublished(
      this.options.tenantId,
      trigger.workflowId,
    );
    if (!published) {
      return { triggerId: trigger.triggerId, started: 0, seeded: false, error: 'no published version' };
    }
    const definition = published.definition as unknown as WorkflowDefinition;

    let cursor = trigger.cursor;
    for (const item of fresh) {
      await this.options.executions.start({
        tenantId: this.options.tenantId,
        workflowId: trigger.workflowId,
        executionId: this.options.newExecutionId(),
        workflowType: 'helixWorkflow',
        definition,
        input: { item, connectorId: trigger.connectorId, event: trigger.event },
      } as never);
      const value = valueOf(item);
      if (field && (cursor === undefined || compareCursor(value, cursor) > 0)) cursor = value;
    }
    if (field && cursor !== undefined && cursor !== trigger.cursor) {
      await this.options.triggers.setCursor(trigger.triggerId, cursor);
    }
    return { triggerId: trigger.triggerId, started: fresh.length, seeded: false, cursor };
  }

  /** Poll every enabled poll-trigger once. Errors never break the loop. */
  async tick(): Promise<PollOutcome[]> {
    const triggers = (await this.options.triggers.listByKind('poll')).filter((t) => t.enabled);
    const outcomes: PollOutcome[] = [];
    for (const trigger of triggers) {
      try {
        outcomes.push(await this.pollOnce(trigger));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`poll ${trigger.triggerId} failed: ${message}`);
        outcomes.push({ triggerId: trigger.triggerId, started: 0, seeded: false, error: message });
      }
    }
    return outcomes;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
