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
 * Trigger bindings: a persisted
 * record that binds an external event to a workflow. Three kinds, all on
 * the same substrate and none needing AWS:
 *
 *   - webhook: an inbound HTTP call (POST /hooks/:triggerId) starts the
 *     workflow, after per-provider signature verification.
 *   - poll:    the ConnectorPoller calls a connector operation on a
 *     cadence, diffs a cursor, and starts one run per new item.
 *   - schedule: a native Temporal Schedule (cron) starts the workflow.
 *
 * Tenant-scoped: the single-tenant runtime constructs one service
 * per tenant, so an unauthenticated webhook still resolves its tenant.
 */
import { randomUUID } from 'node:crypto';
import type { TableDefinition } from '@mindlynx/metis-ports';
import type { DataGateway } from '@mindlynx/metis-data-gateway';

export const TRIGGERS_TABLE: TableDefinition = {
  name: 'triggers',
  partitionAttribute: 'PK',
  sortAttribute: 'SK',
};

export function registerTriggerTable(gateway: DataGateway): void {
  gateway.registerDefinition(TRIGGERS_TABLE);
}

export type TriggerKind = 'webhook' | 'poll' | 'schedule';
/** How an inbound webhook body is authenticated. */
export type TriggerVerification = 'github' | 'hmac' | 'none';

export interface TriggerRecord {
  triggerId: string;
  tenantId: string;
  kind: TriggerKind;
  /** The workflow started when the trigger fires. */
  workflowId: string;
  enabled: boolean;
  connectorId?: string;
  /** The connector event name this binds to (e.g. "push", "newContact"). */
  event?: string;
  /** webhook: signature scheme and shared secret. */
  verification?: TriggerVerification;
  secret?: string;
  /** poll: the connector operation to call, the field to advance the cursor
   * by, where the item array lives in the response, and any op params. */
  operation?: string;
  cursorField?: string;
  cursor?: string;
  itemsPath?: string;
  pollParams?: Record<string, unknown>;
  /** schedule: the cron expression provisioned as a Temporal Schedule. */
  cron?: string;
}

export type TriggerInput = Omit<TriggerRecord, 'tenantId' | 'enabled' | 'triggerId'> &
  Partial<Pick<TriggerRecord, 'triggerId' | 'enabled'>>;

const pk = (tenantId: string) => `TRIG#${tenantId}`;

export class TriggerService {
  constructor(
    private readonly gateway: DataGateway,
    private readonly tenantId: string,
  ) {}

  async create(input: TriggerInput): Promise<TriggerRecord> {
    const record: TriggerRecord = {
      ...input,
      triggerId: input.triggerId ?? `trg_${randomUUID()}`,
      tenantId: this.tenantId,
      enabled: input.enabled ?? true,
    };
    await this.put(record);
    return record;
  }

  async get(triggerId: string): Promise<TriggerRecord | undefined> {
    const item = await this.gateway.read(TRIGGERS_TABLE.name, {
      partitionKey: pk(this.tenantId),
      sortKey: triggerId,
    });
    return item as TriggerRecord | undefined;
  }

  async list(): Promise<TriggerRecord[]> {
    const page = await this.gateway.query({
      table: TRIGGERS_TABLE.name,
      partitionValue: pk(this.tenantId),
    });
    return page.items as unknown as TriggerRecord[];
  }

  async listByKind(kind: TriggerKind): Promise<TriggerRecord[]> {
    return (await this.list()).filter((trigger) => trigger.kind === kind);
  }

  async remove(triggerId: string): Promise<void> {
    await this.gateway.remove(TRIGGERS_TABLE.name, {
      partitionKey: pk(this.tenantId),
      sortKey: triggerId,
    });
  }

  /** Advance the persisted poll cursor after a successful poll tick. */
  async setCursor(triggerId: string, cursor: string): Promise<void> {
    const record = await this.get(triggerId);
    if (!record) return;
    await this.put({ ...record, cursor });
  }

  async setEnabled(triggerId: string, enabled: boolean): Promise<void> {
    const record = await this.get(triggerId);
    if (!record) return;
    await this.put({ ...record, enabled });
  }

  private async put(record: TriggerRecord): Promise<void> {
    await this.gateway.upsert(TRIGGERS_TABLE.name, {
      ...record,
      PK: pk(this.tenantId),
      SK: record.triggerId,
    });
  }
}
