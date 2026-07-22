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
import type { ItemRecord, TableDefinition } from '@mindlynx/metis-ports';
import type { DataGateway } from './gateway.js';

/**
 * The workflow-specific method set over the gateway:
 * two logical stores, workflows (one item per version) and
 * workflow_executions (a META item plus LOG items per run, 90-day TTL).
 * Version and changeset are zero-padded in sort keys so lexical order
 * is numeric order; listing indexes carry exactly one row per workflow
 * (the newest version) and only META rows populate execution indexes.
 */

export const WORKFLOWS_TABLE: TableDefinition = {
  name: 'workflows',
  partitionAttribute: 'PK',
  sortAttribute: 'SK',
  indexes: [
    { name: 'listByUpdated', partitionAttribute: 'gsi1pk', sortAttribute: 'updatedAt' },
    { name: 'listByStatus', partitionAttribute: 'gsi2pk', sortAttribute: 'updatedAt' },
  ],
};

export const WORKFLOW_EXECUTIONS_TABLE: TableDefinition = {
  name: 'workflow_executions',
  partitionAttribute: 'PK',
  sortAttribute: 'SK',
  ttlAttribute: 'ttl',
  indexes: [
    { name: 'byTenant', partitionAttribute: 'gsi1pk', sortAttribute: 'startTime' },
    { name: 'byWorkflow', partitionAttribute: 'gsi2pk', sortAttribute: 'startTime' },
    { name: 'byStatus', partitionAttribute: 'gsi3pk', sortAttribute: 'startTime' },
  ],
};

export function registerWorkflowTables(gateway: DataGateway): void {
  gateway.registerDefinition(WORKFLOWS_TABLE);
  gateway.registerDefinition(WORKFLOW_EXECUTIONS_TABLE);
}

export interface WorkflowVersionItem extends ItemRecord {
  tenantId: string;
  workflowId: string;
  version: number;
  changeset: number;
  status: string;
  name: string;
  description?: string;
  type: string;
  definition: Record<string, unknown>;
}

export interface ExecutionMetaItem extends ItemRecord {
  tenantId: string;
  executionId: string;
  workflowId: string;
  status: string;
  startTime: string;
}

export interface ExecutionLogItem extends ItemRecord {
  tenantId: string;
  executionId: string;
  sequence: number;
}

export interface ListOptions {
  status?: string;
  limit: number;
  cursor?: string;
}

export interface ListExecutionsOptions extends ListOptions {
  workflowId?: string;
}

const pad = (n: number): string => String(n).padStart(6, '0');

const workflowPk = (tenantId: string, workflowId: string) => `WF#${tenantId}#${workflowId}`;
const versionSk = (version: number, changeset: number) => `VER#${pad(version)}#${pad(changeset)}`;
const executionPk = (tenantId: string, executionId: string) => `EXEC#${tenantId}#${executionId}`;
const logSk = (sequence: number) => `LOG#${pad(sequence)}`;

export interface WorkflowStoreOptions {
  clock?: () => number;
  executionTtlDays?: number;
}

export class WorkflowStore {
  private readonly clock: () => number;
  private readonly executionTtlDays: number;

  constructor(
    private readonly gateway: DataGateway,
    options: WorkflowStoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.executionTtlDays = options.executionTtlDays ?? 90;
  }

  /** How long execution rows are kept - THE Metis retention (vs Temporal's). */
  get retentionDays(): number {
    return this.executionTtlDays;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private ttl(): number {
    return Math.floor(this.clock() / 1000) + this.executionTtlDays * 24 * 60 * 60;
  }

  async putWorkflowVersion(item: WorkflowVersionItem): Promise<void> {
    const pk = workflowPk(item.tenantId, item.workflowId);
    const sk = versionSk(item.version, item.changeset);
    const newest = await this.gateway.query({
      table: WORKFLOWS_TABLE.name,
      partitionValue: pk,
      sortPrefix: 'VER#',
      ascending: false,
      limit: 1,
    });
    const currentNewest = newest.items[0];
    const isNewest = !currentNewest || String(currentNewest.SK) <= sk;

    const record: ItemRecord = {
      ...item,
      PK: pk,
      SK: sk,
      deleted: item.deleted ?? false,
      createdAt: item.createdAt ?? this.nowIso(),
      updatedAt: this.nowIso(),
      gsi1pk: isNewest ? `TENANT#${item.tenantId}` : null,
      gsi2pk: isNewest ? `TENANT#${item.tenantId}#STATUS#${item.status}` : null,
    };
    await this.gateway.upsert(WORKFLOWS_TABLE.name, record);

    if (isNewest && currentNewest && String(currentNewest.SK) !== sk) {
      await this.gateway.update(
        WORKFLOWS_TABLE.name,
        { partitionKey: pk, sortKey: String(currentNewest.SK) },
        { gsi1pk: null, gsi2pk: null },
      );
    }
  }

  async getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
    changeset: number,
  ): Promise<WorkflowVersionItem | undefined> {
    const item = await this.gateway.read(WORKFLOWS_TABLE.name, {
      partitionKey: workflowPk(tenantId, workflowId),
      sortKey: versionSk(version, changeset),
    });
    return item as WorkflowVersionItem | undefined;
  }

  async getLatestVersion(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowVersionItem | undefined> {
    const page = await this.gateway.query({
      table: WORKFLOWS_TABLE.name,
      partitionValue: workflowPk(tenantId, workflowId),
      sortPrefix: 'VER#',
      ascending: false,
      limit: 1,
    });
    return page.items[0] as WorkflowVersionItem | undefined;
  }

  /** The changeset history, newest first (the Versions panel). */
  async listVersions(
    tenantId: string,
    workflowId: string,
    limit = 50,
  ): Promise<WorkflowVersionItem[]> {
    const page = await this.gateway.query({
      table: WORKFLOWS_TABLE.name,
      partitionValue: workflowPk(tenantId, workflowId),
      sortPrefix: 'VER#',
      ascending: false,
      limit,
    });
    return page.items as unknown as WorkflowVersionItem[];
  }

  async getLatestPublished(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowVersionItem | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.gateway.query({
        table: WORKFLOWS_TABLE.name,
        partitionValue: workflowPk(tenantId, workflowId),
        sortPrefix: 'VER#',
        ascending: false,
        limit: 25,
        cursor,
      });
      const published = page.items.find(
        (item) => item.status === 'published' && item.deleted !== true,
      );
      if (published) return published as WorkflowVersionItem;
      cursor = page.cursor;
    } while (cursor);
    return undefined;
  }

  async listWorkflows(
    tenantId: string,
    options: ListOptions,
  ): Promise<{ items: WorkflowVersionItem[]; cursor?: string }> {
    const page = await this.gateway.query({
      table: WORKFLOWS_TABLE.name,
      index: options.status ? 'listByStatus' : 'listByUpdated',
      partitionValue: options.status
        ? `TENANT#${tenantId}#STATUS#${options.status}`
        : `TENANT#${tenantId}`,
      ascending: false,
      limit: options.limit,
      cursor: options.cursor,
    });
    return { items: page.items as WorkflowVersionItem[], cursor: page.cursor };
  }

  async softDeleteWorkflow(tenantId: string, workflowId: string): Promise<void> {
    const pk = workflowPk(tenantId, workflowId);
    let cursor: string | undefined;
    do {
      const page = await this.gateway.query({
        table: WORKFLOWS_TABLE.name,
        partitionValue: pk,
        limit: 50,
        cursor,
      });
      for (const item of page.items) {
        await this.gateway.update(
          WORKFLOWS_TABLE.name,
          { partitionKey: pk, sortKey: String(item.SK) },
          { deleted: true, gsi1pk: null, gsi2pk: null },
        );
      }
      cursor = page.cursor;
    } while (cursor);
  }

  async writeExecutionMeta(meta: ExecutionMetaItem): Promise<void> {
    await this.gateway.upsert(WORKFLOW_EXECUTIONS_TABLE.name, {
      ...meta,
      PK: executionPk(meta.tenantId, meta.executionId),
      SK: 'META',
      ttl: this.ttl(),
      gsi1pk: `TENANT#${meta.tenantId}`,
      gsi2pk: `TENANT#${meta.tenantId}#WF#${meta.workflowId}`,
      gsi3pk: `TENANT#${meta.tenantId}#STATUS#${meta.status}`,
    });
  }

  async updateExecutionMeta(
    tenantId: string,
    executionId: string,
    patch: ItemRecord,
  ): Promise<void> {
    const changes: ItemRecord = { ...patch };
    if (typeof patch.status === 'string') {
      changes.gsi3pk = `TENANT#${tenantId}#STATUS#${patch.status}`;
    }
    await this.gateway.update(
      WORKFLOW_EXECUTIONS_TABLE.name,
      { partitionKey: executionPk(tenantId, executionId), sortKey: 'META' },
      changes,
    );
  }

  async appendExecutionLog(log: ExecutionLogItem): Promise<void> {
    await this.gateway.upsert(WORKFLOW_EXECUTIONS_TABLE.name, {
      ...log,
      PK: executionPk(log.tenantId, log.executionId),
      SK: logSk(log.sequence),
      ttl: this.ttl(),
    });
  }

  async getExecution(
    tenantId: string,
    executionId: string,
  ): Promise<{ meta: ExecutionMetaItem; logs: ExecutionLogItem[] } | undefined> {
    const items: ItemRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.gateway.query({
        table: WORKFLOW_EXECUTIONS_TABLE.name,
        partitionValue: executionPk(tenantId, executionId),
        limit: 100,
        cursor,
      });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor);

    const meta = items.find((item) => item.SK === 'META');
    if (!meta) return undefined;
    const logs = items.filter((item) => String(item.SK).startsWith('LOG#'));
    return { meta: meta as ExecutionMetaItem, logs: logs as ExecutionLogItem[] };
  }

  async listExecutions(
    tenantId: string,
    options: ListExecutionsOptions,
  ): Promise<{ items: ExecutionMetaItem[]; cursor?: string }> {
    let index = 'byTenant';
    let partitionValue = `TENANT#${tenantId}`;
    if (options.workflowId) {
      index = 'byWorkflow';
      partitionValue = `TENANT#${tenantId}#WF#${options.workflowId}`;
    } else if (options.status) {
      index = 'byStatus';
      partitionValue = `TENANT#${tenantId}#STATUS#${options.status}`;
    }
    const page = await this.gateway.query({
      table: WORKFLOW_EXECUTIONS_TABLE.name,
      index,
      partitionValue,
      ascending: false,
      limit: options.limit,
      cursor: options.cursor,
    });
    return { items: page.items as ExecutionMetaItem[], cursor: page.cursor };
  }
}
