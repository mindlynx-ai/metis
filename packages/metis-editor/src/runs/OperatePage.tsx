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
 * Operate: the ONE runs surface - every run of every workflow (Temporal
 * visibility), live over the socket, plus mission control on top: status
 * counts, worker/queue health ("is my worker alive" - THE Temporal question),
 * schedules with pause/resume, and per-run levers (graceful cancel, hard
 * terminate, reset). Absorbed the former History page; /history redirects
 * here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { io } from 'socket.io-client';
import { api, getToken, type TemporalExecution } from '../api.js';
import { Icon } from '../ui/Icon.js';
import { durationBetween, timeAgo } from './format.js';
import { UpcomingSection } from './UpcomingSection.js';
import { ArchiveSection } from './ArchiveSection.js';

// Socket events drive refresh; the poll is only a fallback.
const POLL_MS = 15000;

// 'Waiting' is Running split client-side by whereabouts (parked on an outside
// event vs actively working) - Temporal itself has no such visibility filter.
const STATUS_FILTERS = ['All', 'Running', 'Waiting', 'Completed', 'Failed', 'Terminated', 'Canceled'] as const;

/** The Temporal visibility status a filter tab asks the server for. */
function serverStatusFor(filter: string): string | undefined {
  if (filter === 'All') return undefined;
  if (filter === 'Waiting') return 'Running';
  return filter;
}

interface ScheduleRow {
  scheduleId: string;
  workflowId: string;
  workflowName?: string;
  paused: boolean;
  cron?: string;
  nextRun?: string;
  nextRuns?: string[];
}

interface Summary {
  counts?: Record<string, number>;
  queue?: {
    taskQueue: string;
    pollers: { identity: string; lastAccessTime?: string }[];
    backlogCount?: number;
    backlogAgeSeconds?: number;
  };
}

/** Named filter views, kept in the browser (the official-UI pattern). */
const VIEWS_KEY = 'metis-operate-views';
function loadViews(): { name: string; filter: string }[] {
  try {
    return JSON.parse(localStorage.getItem(VIEWS_KEY) ?? '[]') as { name: string; filter: string }[];
  } catch {
    return [];
  }
}

export function OperatePage() {
  const [summary, setSummary] = useState<Summary>();
  const [rows, setRows] = useState<TemporalExecution[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('All');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [views, setViews] = useState(loadViews);

  const saveView = () => {
    const name = window.prompt('Name this view', filter);
    if (!name) return;
    const next = [...views.filter((view) => view.name !== name), { name, filter }];
    setViews(next);
    localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
  };
  const removeView = (name: string) => {
    const next = views.filter((view) => view.name !== name);
    setViews(next);
    localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
  };

  const load = useCallback(async (status: string) => {
    try {
      const [summaryResult, listResult, scheduleResult] = await Promise.all([
        api.operateSummary(),
        api.temporalExecutions(serverStatusFor(status)),
        api.operateSchedules().catch(() => ({ items: [] })),
      ]);
      setSummary(summaryResult);
      setRows(listResult.items);
      setSchedules(scheduleResult.items);
      setError(undefined);
    } catch {
      setError('could not reach Temporal');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Live refresh on execution events (single-tenant room), poll as fallback.
  useEffect(() => {
    const socket = io({ path: '/ws/workflows', auth: { token: getToken() ?? '' }, transports: ['websocket'] });
    const join = () => socket.emit('join', { room: 'tenant:t1:workflows' });
    socket.on('connect', join);
    join();
    socket.on('workflow-event', (event: { name?: string }) => {
      if (event.name?.startsWith('workflow.execution.') && !document.hidden) void load(filter);
    });
    const timer = setInterval(() => {
      if (!document.hidden) void load(filter);
    }, POLL_MS);
    return () => {
      socket.disconnect();
      clearInterval(timer);
    };
  }, [filter, load]);

  const toggleSchedule = async (row: ScheduleRow) => {
    setBusy(row.scheduleId);
    try {
      if (row.paused) await api.resumeSchedule(row.workflowId);
      else await api.pauseSchedule(row.workflowId);
      await load(filter);
    } catch {
      setError(`could not ${row.paused ? 'resume' : 'pause'} ${row.workflowId}`);
    } finally {
      setBusy(undefined);
    }
  };

  const act = async (kind: 'cancel' | 'terminate' | 'reset', executionId: string) => {
    setBusy(executionId);
    try {
      if (kind === 'cancel') await api.cancelExecution(executionId);
      if (kind === 'terminate') await api.terminateExecution(executionId);
      if (kind === 'reset') await api.resetExecution(executionId);
      await load(filter);
    } catch {
      setError(`${kind} failed for ${executionId}`);
    } finally {
      setBusy(undefined);
    }
  };

  const counts = summary?.counts ?? {};
  const pollers = summary?.queue?.pollers ?? [];
  const workerAlive = pollers.length > 0;
  const now = Date.now();
  const visibleRows = filter === 'Waiting' ? rows.filter((row) => row.runState === 'waiting') : rows;
  const showEmpty = loaded && rows.length === 0 && filter === 'All' && !error;

  // The executions that are GOING to run: every schedule's next fire times.
  const upcoming = schedules
    .filter((schedule) => !schedule.paused)
    .flatMap((schedule) =>
      (schedule.nextRuns ?? []).map((when) => ({
        when,
        label: schedule.workflowName ?? schedule.workflowId,
        cron: schedule.cron,
      })),
    )
    .sort((a, b) => a.when.localeCompare(b.when))
    .slice(0, 8);

  const copyText = (value: string) => {
    navigator.clipboard?.writeText(value).catch(() => undefined);
  };

  const whereaboutsOf = (row: TemporalExecution): string | undefined => {
    if (row.runState === 'waiting') {
      if (row.waitingOn?.signalType) return `waiting for signal: ${row.waitingOn.signalType}`;
      if (row.waitingOn?.until) return `waiting until ${new Date(row.waitingOn.until).toLocaleTimeString()}`;
      return 'waiting for an outside event';
    }
    if (row.atNode) return `at ${row.atNode}`;
    return undefined;
  };

  return (
    <main className="shell-main operate-page" aria-label="Operate">
      <header className="page-hero">
        <div>
          <h1 className="page-title">Operate</h1>
          <p className="page-hero-sub">
            Every run of every workflow, live - plus the workers, schedules and levers to stop
            or replay them. Open a run to see exactly what happened at each step.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void load(filter)}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </header>

      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}

      <section className="operate-counts" aria-label="Run counts">
        {['running', 'completed', 'failed', 'terminated'].map((key) => (
          <div className={`op-count op-${key}`} key={key}>
            <span className="op-count-value">{counts[key] ?? 0}</span>
            <span className="op-count-label">{key}</span>
          </div>
        ))}
        <div className={`op-count op-worker ${workerAlive ? 'op-ok' : 'op-down'}`} data-testid="worker-health">
          <span className="op-count-value">
            <Icon name={workerAlive ? 'check' : 'alert'} size={18} />
            {pollers.length}
          </span>
          <span className="op-count-label">
            {workerAlive ? 'workers polling' : 'NO WORKERS'} ({summary?.queue?.taskQueue ?? 'queue'})
          </span>
          {(summary?.queue?.backlogCount ?? 0) > 0 && (
            <span className="op-backlog">
              {summary?.queue?.backlogCount} queued
              {(summary?.queue?.backlogAgeSeconds ?? 0) > 0 && `, oldest ${summary?.queue?.backlogAgeSeconds}s`}
            </span>
          )}
        </div>
      </section>

      <UpcomingSection entries={upcoming} now={now} />

      {schedules.length > 0 && (
        <section aria-label="Schedules" className="operate-schedules">
          <h2 className="op-section-title">Schedules</h2>
          <div className="runs-table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Cron</th>
                  <th>State</th>
                  <th>Next run</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((row) => (
                  <tr key={row.scheduleId}>
                    <td>
                      {row.workflowName ?? <span className="mono">{row.workflowId}</span>}
                    </td>
                    <td className="mono">{row.cron ?? ''}</td>
                    <td>
                      <span className={`status ${row.paused ? 'status-cancelled' : 'status-running'}`}>
                        {row.paused ? 'paused' : 'active'}
                      </span>
                    </td>
                    <td>{row.nextRun ? new Date(row.nextRun).toLocaleString() : ''}</td>
                    <td className="op-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy === row.scheduleId}
                        onClick={() => toggleSchedule(row)}
                      >
                        {row.paused ? 'Resume' : 'Pause'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section aria-label="Runs board">
        <div className="operate-toolbar">
          <div className="operate-filters" role="tablist" aria-label="Status filter">
            {STATUS_FILTERS.map((status) => (
              <button
                key={status}
                type="button"
                role="tab"
                aria-selected={filter === status}
                className={`seg-btn${filter === status ? ' active' : ''}`}
                onClick={() => setFilter(status)}
              >
                {status}
              </button>
            ))}
          </div>
          {views.map((view) => (
            <span className="view-chip" key={view.name}>
              <button type="button" className="view-chip-apply" onClick={() => setFilter(view.filter as typeof filter)}>
                {view.name}
              </button>
              <button type="button" className="view-chip-x" aria-label={`Remove view ${view.name}`} onClick={() => removeView(view.name)}>
                ×
              </button>
            </span>
          ))}
          <button type="button" className="btn btn-sm" onClick={saveView}>
            Save view
          </button>
        </div>

        {!loaded && (
          <div className="runs-table-wrap" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton runs-skeleton" />
            ))}
          </div>
        )}

        {showEmpty && (
          <div className="conn-empty">
            <div className="conn-empty-mark" aria-hidden="true">
              <Icon name="clock" size={28} />
            </div>
            <h2>No runs yet</h2>
            <p>Run a workflow and every step of it lands here, ready to inspect.</p>
            <Link className="btn btn-primary" to="/workflows">
              Go to workflows
            </Link>
          </div>
        )}

        {loaded && !showEmpty && (
          <div className="runs-table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Took</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={`${row.workflowId}-${row.runId}`}>
                    <td className="runs-cell-run">
                      {/* Temporal's workflowId IS the Metis executionId; both ids matter. */}
                      <Link
                        to={`/executions/${encodeURIComponent(row.workflowId)}`}
                        state={{ from: '/operate' }}
                      >
                        {row.workflowName ?? row.workflowId}
                      </Link>
                      <span className="runs-sub mono">
                        {row.workflowId}
                        {row.definitionVersion !== undefined && (
                          <span className="ver-chip">v{row.definitionVersion}·c{row.definitionChangeset ?? 0}</span>
                        )}
                      </span>
                      <span className="runs-sub runs-runid">
                        run {row.runId.slice(0, 8)}…
                        <button
                          type="button"
                          className="copy-btn"
                          title="Copy the Temporal runId"
                          aria-label={`Copy runId ${row.runId}`}
                          onClick={() => copyText(row.runId)}
                        >
                          <Icon name="link" size={11} />
                        </button>
                      </span>
                    </td>
                    <td>
                      <span className={`status status-${row.runState === 'waiting' ? 'waiting' : row.status}`}>
                        {row.runState === 'waiting' ? 'waiting' : row.status}
                      </span>
                      {whereaboutsOf(row) && <span className="runs-sub">{whereaboutsOf(row)}</span>}
                    </td>
                    <td title={row.startTime}>{timeAgo(row.startTime, now)}</td>
                    <td>{durationBetween(row.startTime, row.closeTime) ?? '-'}</td>
                    <td className="op-actions">
                      {row.status === 'running' && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy === row.workflowId}
                            onClick={() => act('cancel', row.workflowId)}
                            title="Graceful stop: the run finalises its own state"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm kv-remove"
                            disabled={busy === row.workflowId}
                            onClick={() => act('terminate', row.workflowId)}
                            title="Hard stop: the workflow gets no say"
                          >
                            Terminate
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy === row.workflowId}
                        onClick={() => act('reset', row.workflowId)}
                        title="Re-run from the first workflow task"
                      >
                        Reset
                      </button>
                    </td>
                  </tr>
                ))}
                {visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="help">
                      No runs match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ArchiveSection />
    </main>
  );
}
