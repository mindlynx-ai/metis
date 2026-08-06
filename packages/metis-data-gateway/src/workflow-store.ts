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
import { ConditionFailedError } from '@mindlynx/metis-ports';
import type { ItemRecord, PatchOptions, TableDefinition } from '@mindlynx/metis-ports';
import type { DataGateway } from './gateway.js';

/**
 * The workflow-specific method set over the gateway:
 * two logical stores, workflows (one item per version) and
 * workflow_executions (a META item plus LOG items per run, kept until an
 * operator's retention window says otherwise - see pruneExecutions).
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
  /**
   * Which attempt of the activity wrote this row (Temporal's own count, 1 on
   * the first). Absent means one, which is what every row written before this
   * field existed means too.
   */
  activityAttempt?: number;
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
/**
 * A log row's sort key. The sequence is derived from workflow history, so it is
 * IDENTICAL on every retry of the same activity: without the attempt in the key
 * the second attempt upserts over the first and the run shows one attempt of a
 * node that ran twice. Attempt 1 keeps the bare key so existing rows keep both
 * their key and their place; a later attempt sorts immediately after the row it
 * would have replaced, which is also where it belongs in time.
 */
const logSk = (sequence: number, attempt = 1) =>
  attempt > 1
    ? `LOG#${pad(sequence)}#A${String(attempt).padStart(2, '0')}`
    : `LOG#${pad(sequence)}`;

export interface WorkflowStoreOptions {
  clock?: () => number;
  /** Operator retention window in days. Undefined = keep everything. */
  retentionDays?: number;
}

/**
 * The statuses a run can END in. Anything else - 'running', or a status a later
 * version invents - counts as still going and is never pruned. An allowlist,
 * not a denylist of 'running': a new status must be added here deliberately
 * before prune will delete it, so forgetting keeps data rather than losing it.
 */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'terminated',
]);

export interface PruneOptions {
  /** Window in days. Defaults to the store's configured retention. */
  olderThanDays?: number;
  /** Report what would go without deleting any of it. */
  dryRun?: boolean;
}

export interface PruneResult {
  /** Runs deleted - or, on a dry run, that would have been. */
  executions: number;
  /** Rows across those runs: one META plus its LOGs. */
  rows: number;
  /** Runs old enough to go but spared because they are still going. */
  kept: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class WorkflowStore {
  private readonly clock: () => number;
  private readonly retention: number | undefined;

  constructor(
    private readonly gateway: DataGateway,
    options: WorkflowStoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.retention = options.retentionDays;
  }

  /**
   * How long execution rows are kept - THE Metis retention (vs Temporal's).
   * Undefined is the default and means everything is kept: an upgrade must
   * never silently delete history nobody agreed to lose. Deletion is opt-in.
   */
  get retentionDays(): number | undefined {
    return this.retention;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /**
   * `options.mustBeNew` refuses to write over an existing changeset. The write
   * is an upsert by default because publish rewrites the row it read; but a
   * caller that MINTED the changeset number from a read (latest + 1) has a lost
   * update waiting in it - two editors both compute changeset 6, the second
   * overwrites the first and both are told they saved.
   */
  async putWorkflowVersion(
    item: WorkflowVersionItem,
    options?: { mustBeNew?: boolean },
  ): Promise<void> {
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
    // A deleted workflow takes no more versions. Deletion is soft and delisting
    // is done by nulling the listing keys, which the write below sets again for
    // whatever is newest - so without this, any save or publish put a workflow
    // whose own row says deleted straight back into the list, and `deleted`
    // rode along as true. The refusal belongs here rather than in each route
    // because every writer (routes, MCP, a future importer) comes through this
    // one function, and it costs nothing: the read it needs is already done.
    if (currentNewest?.deleted === true) {
      throw new ConditionFailedError('the workflow was deleted');
    }
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
    if (options?.mustBeNew) {
      await this.gateway.create(WORKFLOWS_TABLE.name, record);
    } else {
      await this.gateway.upsert(WORKFLOWS_TABLE.name, record);
    }

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
    // The index is the primary filter (a soft delete nulls the keys) and this
    // is the second one, because the index has been wrong before: a row whose
    // keys were rewritten is otherwise listed with `deleted: true` on it and
    // the listing is the one place a user checks that a delete took. A page
    // may come back short; the cursor, not the count, says whether there is
    // more, which is already true of a sparse index.
    const items = (page.items as WorkflowVersionItem[]).filter((item) => item.deleted !== true);
    return { items, cursor: page.cursor };
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
      gsi1pk: `TENANT#${meta.tenantId}`,
      gsi2pk: `TENANT#${meta.tenantId}#WF#${meta.workflowId}`,
      gsi3pk: `TENANT#${meta.tenantId}#STATUS#${meta.status}`,
    });
  }

  /**
   * `options.ifMatches` is for a caller whose read is older than this write:
   * pass what the row was when the decision was made and a row that has moved
   * on since raises ConditionFailedError instead of being overwritten.
   */
  async updateExecutionMeta(
    tenantId: string,
    executionId: string,
    patch: ItemRecord,
    options?: PatchOptions,
  ): Promise<void> {
    const changes: ItemRecord = { ...patch };
    if (typeof patch.status === 'string') {
      changes.gsi3pk = `TENANT#${tenantId}#STATUS#${patch.status}`;
    }
    await this.gateway.update(
      WORKFLOW_EXECUTIONS_TABLE.name,
      { partitionKey: executionPk(tenantId, executionId), sortKey: 'META' },
      changes,
      options,
    );
  }

  async appendExecutionLog(log: ExecutionLogItem): Promise<void> {
    await this.gateway.upsert(WORKFLOW_EXECUTIONS_TABLE.name, {
      ...log,
      PK: executionPk(log.tenantId, log.executionId),
      SK: logSk(log.sequence, log.activityAttempt),
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

  /**
   * Delete every row of one run (META and its LOGs), returning the count.
   * `countOnly` walks the same rows without deleting - the dry run.
   */
  private async removeExecution(
    tenantId: string,
    executionId: string,
    countOnly: boolean,
  ): Promise<number> {
    const pk = executionPk(tenantId, executionId);
    let rows = 0;
    let cursor: string | undefined;
    do {
      const page = await this.gateway.query({
        table: WORKFLOW_EXECUTIONS_TABLE.name,
        partitionValue: pk,
        limit: 100,
        cursor,
      });
      for (const item of page.items) {
        if (!countOnly) {
          await this.gateway.remove(WORKFLOW_EXECUTIONS_TABLE.name, {
            partitionKey: pk,
            sortKey: String(item.SK),
          });
        }
        rows += 1;
      }
      cursor = page.cursor;
    } while (cursor);
    return rows;
  }

  /**
   * Enforce the retention window: delete closed runs whose history is older
   * than it, META and LOG rows alike.
   *
   * Three rules, in the order they matter:
   *
   * 1. No window, no deletion. `olderThanDays` falls back to the store's
   *    configured retention, which is undefined unless an operator set one -
   *    and then this returns having read nothing and deleted nothing. The
   *    guard is HERE rather than in each caller so that a scheduler, a CLI
   *    command and any future route are all safe by construction.
   * 2. A run that is still going is never touched, whatever its age. Parked on
   *    a signal since April is not abandoned. "Still going" is the complement
   *    of CLOSED_STATUSES - an allowlist, so an unfamiliar status survives.
   * 3. A run is aged by when it ENDED, falling back to when it started. A run
   *    that started ninety days ago and finished yesterday is a day old; the
   *    index is on startTime, which only ever over-selects (endTime >= start),
   *    so it still bounds the scan to candidates.
   *
   * Concurrency: this only reads and deletes by key, both idempotent, and
   * never writes. Two processes sweeping at once therefore agree on the
   * outcome and may only double-COUNT what they each saw - no lock needed.
   */
  async pruneExecutions(tenantId: string, options: PruneOptions = {}): Promise<PruneResult> {
    const result: PruneResult = { executions: 0, rows: 0, kept: 0 };
    const days = options.olderThanDays ?? this.retention;
    if (days === undefined) return result;
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`retention window must be a non-negative number of days, not ${days}`);
    }
    const cutoff = new Date(this.clock() - days * DAY_MS).toISOString();

    let cursor: string | undefined;
    do {
      const page = await this.gateway.query({
        table: WORKFLOW_EXECUTIONS_TABLE.name,
        index: 'byTenant',
        partitionValue: `TENANT#${tenantId}`,
        sortRange: { to: cutoff },
        limit: 100,
        cursor,
      });
      for (const meta of page.items) {
        const closedAt = typeof meta.endTime === 'string' ? meta.endTime : meta.startTime;
        // An undated row has an unknown age, which is not the same as an old
        // one, so it is kept too.
        if (
          !CLOSED_STATUSES.has(String(meta.status)) ||
          typeof closedAt !== 'string' ||
          closedAt > cutoff
        ) {
          result.kept += 1;
          continue;
        }
        result.executions += 1;
        result.rows += await this.removeExecution(
          tenantId,
          String(meta.executionId),
          options.dryRun === true,
        );
      }
      cursor = page.cursor;
    } while (cursor);
    return result;
  }
}
