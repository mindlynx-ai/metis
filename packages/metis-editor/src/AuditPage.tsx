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
 * Activity: the audit trail, made visible. Who did what, to which thing,
 * when. Newest first, because the question is nearly always "what just
 * happened"; filterable by person and by kind of action for the two that
 * follow it.
 *
 * This is deliberately not the run log. The run log lives on a run and says
 * what the workflow did. This says what a PERSON did, including the things
 * that never belonged to a run: publishing, storing a credential, signing in.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, type AuditRecord } from './api.js';
import { Icon } from './ui/Icon.js';

/** Group the actions into the handful of families worth filtering by. */
const FAMILIES = [
  { key: 'all', label: 'Everything' },
  { key: 'execution', label: 'Runs' },
  { key: 'workflow', label: 'Workflows' },
  { key: 'connection', label: 'Credentials' },
  { key: 'auth', label: 'Sign-ins' },
] as const;

type Family = (typeof FAMILIES)[number]['key'];

/** Plain English for the row. The action itself stays visible as a chip. */
function describe(entry: AuditRecord): string {
  const detail = entry.detail ?? {};
  switch (entry.action) {
    case 'execution.cancelled':
      return detail.reason ? `Cancelled a run: ${String(detail.reason)}` : 'Cancelled a run';
    case 'execution.terminated':
      return 'Terminated a run';
    case 'execution.signalled':
      return `Sent the signal ${String(detail.signalType ?? '')}`.trim();
    case 'workflow.created':
      return `Created the workflow ${String(detail.name ?? '')}`.trim();
    case 'workflow.published':
      return `Published version ${String(detail.version ?? '')}`.trim();
    case 'workflow.deleted':
      return 'Deleted a workflow';
    case 'connection.created':
      return `Stored credentials for ${String(detail.connectorId ?? 'a service')}`;
    case 'connection.updated':
      return detail.materialReplaced ? 'Replaced stored credentials' : 'Renamed a connection';
    case 'connection.deleted':
      return 'Deleted a connection';
    case 'auth.login':
      return entry.outcome === 'denied' ? 'Sign-in rejected' : 'Signed in';
    default:
      return entry.action;
  }
}

/** A run or workflow id is worth following; everything else is just text. */
function entityLink(entry: AuditRecord) {
  if (entry.entityType === 'execution') {
    return <Link to={`/executions/${entry.entityId}`}>{entry.entityId}</Link>;
  }
  return <span className="audit-entity">{entry.entityId}</span>;
}

function when(at: string): string {
  const stamp = new Date(at);
  const seconds = Math.round((Date.now() - stamp.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return stamp.toLocaleString();
}

export function AuditPage() {
  const [entries, setEntries] = useState<AuditRecord[]>();
  const [family, setFamily] = useState<Family>('all');
  const [actor, setActor] = useState('');
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const result = await api.audit({ actor: actor || undefined, limit: 200 });
      setEntries(result.items);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [actor]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    if (!entries) return undefined;
    if (family === 'all') return entries;
    return entries.filter((entry) => entry.action.startsWith(family));
  }, [entries, family]);

  const actors = useMemo(
    () => [...new Set((entries ?? []).map((entry) => entry.actor))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );

  return (
    <main className="shell-main audit-page" aria-label="Activity">
      <header className="page-hero">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-hero-sub">
            Who did what, and when. Every run cancelled, workflow published, credential stored and
            sign-in, newest first. Nothing here can be edited or deleted.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void load()}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </header>

      <div className="conn-toolbar">
        <div className="conn-tabs" role="tablist" aria-label="Filter by kind">
          {FAMILIES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={family === item.key}
              className={`conn-tab${family === item.key ? ' active' : ''}`}
              onClick={() => setFamily(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <select
          className="connector-search audit-actor"
          aria-label="Filter by person"
          value={actor}
          onChange={(event) => setActor(event.target.value)}
        >
          <option value="">Everyone</option>
          {actors.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="empty-note">Could not load activity: {error}</p>}
      {!entries && !error && <p className="empty-note">Loading activity...</p>}
      {shown?.length === 0 && <p className="empty-note">Nothing recorded yet.</p>}

      {shown && shown.length > 0 && (
        <div className="runs-table-wrap">
        <table className="runs-table audit-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What happened</th>
              <th scope="col">To</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.auditId} className={entry.outcome === 'denied' ? 'audit-denied' : undefined}>
                <td className="audit-when" title={entry.at}>
                  {when(entry.at)}
                </td>
                <td className="audit-actor-cell">{entry.actor}</td>
                <td>
                  {entry.outcome === 'denied' && <Icon name="alert" size={14} className="audit-warn" />}
                  {describe(entry)}
                  <span className="audit-action">{entry.action}</span>
                </td>
                <td className="audit-target">{entityLink(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </main>
  );
}
