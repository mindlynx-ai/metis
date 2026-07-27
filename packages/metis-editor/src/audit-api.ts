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

/** The audit trail's shapes and query builder, kept out of the api module. */
export interface AuditQuery {
  actor?: string;
  action?: string;
  entityId?: string;
  limit?: number;
}

/** Build the audit query string. Only the set filters travel. */
export function auditPath(query: AuditQuery): string {
  const search = new URLSearchParams();
  for (const key of ['actor', 'action', 'entityId'] as const) {
    if (query[key]) search.set(key, String(query[key]));
  }
  if (query.limit) search.set('limit', String(query.limit));
  const suffix = search.toString();
  return suffix ? `/api/audit?${suffix}` : '/api/audit';
}

export interface AuditRecord {
  auditId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  outcome?: 'ok' | 'failed' | 'denied';
  detail?: Record<string, unknown>;
  at: string;
}
