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
 * The audit trail: who did what, to which thing, and when.
 *
 * This is NOT the run log. The run log is keyed by execution and answers
 * "what did this workflow do"; it carries no actor and cannot be read across
 * runs. The audit trail is keyed by tenant and time, carries the acting user
 * on every entry, and records the things an auditor asks about that never
 * belonged to a run at all: publishing a workflow, storing a credential,
 * binding a schedule.
 *
 * It is part of the platform, not a paid tier. A record of who approved a
 * refund is not a feature to sell back to the person who needs it.
 *
 * Append only: entries are written once and never updated. Newest first on
 * read, because the question is almost always "what just happened".
 */
import { randomUUID } from 'node:crypto';
import type { TableDefinition } from '@mindlynx/metis-ports';
import type { DataGateway } from './gateway.js';

export const AUDIT_TABLE: TableDefinition = {
  name: 'audit_log',
  partitionAttribute: 'PK',
  sortAttribute: 'SK',
  // "Everything this person did" is the second question every auditor asks,
  // and it should not be a scan of the tenant's whole history.
  indexes: [{ name: 'byActor', partitionAttribute: 'gsi1pk', sortAttribute: 'at' }],
};

export function registerAuditTable(gateway: DataGateway): void {
  gateway.registerDefinition(AUDIT_TABLE);
}

/** What happened. Free-form by design: a closed enum would date badly. */
export interface AuditEntry {
  tenantId: string;
  /** The user who caused it. 'system' when a schedule or a trigger did. */
  actor: string;
  /** Verb in the past tense: execution.started, workflow.published, connection.created. */
  action: string;
  /** What it happened to. */
  entityType: string;
  entityId: string;
  /** Whether the attempt succeeded, for the failures worth seeing. */
  outcome?: 'ok' | 'failed' | 'denied';
  /** Anything worth keeping. Never put secret material in here. */
  detail?: Record<string, unknown>;
  at?: string;
}

export interface AuditRecord extends AuditEntry {
  auditId: string;
  at: string;
}

export interface AuditQuery {
  actor?: string;
  entityId?: string;
  action?: string;
  limit?: number;
}

const pk = (tenantId: string) => `AUDIT#${tenantId}`;
const actorPk = (tenantId: string, actor: string) => `AUDIT#${tenantId}#ACTOR#${actor}`;

export class AuditStore {
  constructor(private readonly gateway: DataGateway) {}

  /**
   * Record an entry. Auditing must never break the thing being audited, so a
   * storage failure is swallowed: a lost line is bad, a refund that fails
   * because the audit table was busy is worse.
   */
  async record(entry: AuditEntry): Promise<AuditRecord | undefined> {
    const at = entry.at ?? new Date().toISOString();
    const auditId = randomUUID();
    const record: AuditRecord = { ...entry, auditId, at };
    try {
      await this.gateway.upsert(AUDIT_TABLE.name, {
        ...record,
        PK: pk(entry.tenantId),
        gsi1pk: actorPk(entry.tenantId, entry.actor),
        // Time first so a range read is chronological, uuid to break ties
        // between entries written in the same millisecond.
        SK: `${at}#${auditId}`,
      });
      return record;
    } catch {
      return undefined;
    }
  }

  /** Newest first, optionally narrowed by actor, entity or action. */
  async list(tenantId: string, query: AuditQuery = {}): Promise<AuditRecord[]> {
    const want = Math.min(Math.max(1, query.limit ?? 50), 500);
    // The answer was always bounded; the READ was not. It fetched the tenant's
    // whole history into memory and then took fifty of it, so the cost of the
    // question grew with the age of the install while the reply stayed the
    // same size. The store can do the taking - the sort key is time-first, so
    // newest-first with a limit is the newest N off the top - and sqlite and
    // postgres push both into the query rather than the process.
    //
    // Only where the answer cannot change: entityId and action are matched
    // here rather than by the store, so bounding those would return the
    // matches among the newest N instead of the newest N matches, and an
    // audit trail that quietly omits is worse than one that is slow. They
    // read the partition whole, as they always have. An actor read is already
    // narrowed by the index it uses, so it bounds safely.
    // ponytail: bounding the other two needs a paging loop AND a ceiling on
    // how far back it will look, which decides what the trail may leave out.
    const bounded = !query.entityId && !query.action;
    const page = await this.gateway.query({
      table: AUDIT_TABLE.name,
      // An actor filter reads the actor index instead of the tenant partition.
      ...(query.actor
        ? { index: 'byActor', partitionValue: actorPk(tenantId, query.actor) }
        : { partitionValue: pk(tenantId) }),
      ascending: false,
      ...(bounded ? { limit: want } : {}),
    });
    const items = (page.items as unknown as AuditRecord[])
      .filter((item) => !query.actor || item.actor === query.actor)
      .filter((item) => !query.entityId || item.entityId === query.entityId)
      .filter((item) => !query.action || item.action === query.action)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return items.slice(0, want);
  }
}
