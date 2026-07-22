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
 * The overview landing: the day's shape of things, computed on the client from
 * the workflow, execution and connection lists (no new backend). Stat cards,
 * a 14-day activity chart, what needs attention, the busiest workflows and the
 * most recent runs - each a link into the surface that explains it.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { computeOverview, type Overview as OverviewData } from './overview-stats.js';
import { Icon } from './ui/Icon.js';

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function headlineFor(data: OverviewData): string {
  if (data.failedRuns > 0) {
    const plural = data.failedRuns > 1 ? 'runs' : 'run';
    return `Mostly smooth - ${data.failedRuns} ${plural} could use a look.`;
  }
  const plural = data.activeWorkflows === 1 ? 'workflow is' : 'workflows are';
  return `Your ${data.activeWorkflows} active ${plural} running smoothly.`;
}

/** The status dot class for a recent run. */
function runDot(status: string): string {
  if (status === 'failed') return 'fail';
  if (status === 'running') return 'run';
  return 'ok';
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  const className = tone ? `ov-stat ov-${tone}` : 'ov-stat';
  return (
    <div className={className}>
      <span className="ov-stat-val">{value}</span>
      <span className="ov-stat-label">{label}</span>
      {sub && <span className="ov-stat-sub">{sub}</span>}
    </div>
  );
}

export function Overview() {
  const [data, setData] = useState<OverviewData>();
  const [loaded, setLoaded] = useState(false);
  const [empty, setEmpty] = useState(false);
  // One "now" shared by the stats and the chart's weekday labels.
  const [now] = useState(() => new Date());

  useEffect(() => {
    Promise.all([
      api.listWorkflows().catch(() => ({ items: [] })),
      api.allExecutions().catch(() => ({ items: [] })),
      api.connections().catch(() => ({ connections: [] })),
    ])
      .then(([workflows, executions, connections]) => {
        setEmpty(workflows.items.length === 0 && executions.items.length === 0);
        setData(
          computeOverview({
            workflows: workflows.items,
            executions: executions.items,
            connections: connections.connections,
            now: now.toISOString(),
          }),
        );
      })
      .finally(() => setLoaded(true));
  }, [now]);

  // The bars are the last 14 UTC days ending today (see overview-stats); label
  // each with the first letter of its actual weekday.
  const dayLetter = (daysAgo: number) =>
    'SMTWTFS'[new Date(now.getTime() - daysAgo * 86_400_000).getUTCDay()];
  const max = data ? Math.max(1, ...data.activity) : 1;
  const headline = data ? headlineFor(data) : 'Your workflows at a glance';

  return (
    <main className="shell-main ov-page" aria-label="Overview">
      <header className="page-hero ov-hero">
        <div>
          <p className="ov-greet">{greeting(new Date())}</p>
          <h1 className="page-title ov-headline">{headline}</h1>
        </div>
        <Link className="btn btn-primary" to="/workflows/new">
          <Icon name="plus" size={14} /> New workflow
        </Link>
      </header>

      {loaded && empty && (
        <div className="conn-empty">
          <div className="conn-empty-mark" aria-hidden="true">
            <Icon name="workflow" size={28} />
          </div>
          <h2>Nothing running yet</h2>
          <p>Build your first workflow: add steps, connect them, press Run.</p>
          <Link className="btn btn-primary" to="/workflows/new">
            Create a workflow
          </Link>
        </div>
      )}

      {data && !empty && (
        <>
          <div className="ov-stats">
            <StatCard label="Active workflows" value={String(data.activeWorkflows)} sub={`${data.totalWorkflows} total`} />
            <StatCard label="Total runs" value={String(data.totalRuns)} sub="across all workflows" />
            <StatCard
              label="Success rate"
              value={`${data.successRate}%`}
              sub={`${data.failedRuns} failed`}
              tone={data.successRate >= 95 ? 'good' : 'warn'}
            />
            <StatCard label="Connected tools" value={String(data.connectedTools)} />
          </div>

          <div className="ov-grid">
            <section className="ov-card ov-activity" aria-labelledby="ov-act-h">
              <h2 className="ov-card-title" id="ov-act-h">
                <Icon name="refresh" size={14} /> Last 14 days
              </h2>
              <div className="ov-bars" role="img" aria-label="Daily runs over the last 14 days">
                {data.activity.map((value, index) => (
                  <div className="ov-bar-col" key={index}>
                    <div className="ov-bar" style={{ height: `${Math.round((value / max) * 100)}%` }} title={`${value} runs`} />
                    <span className="ov-bar-day">
                      {index % 2 === 1 ? dayLetter(data.activity.length - 1 - index) : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className={`ov-card ov-attn${data.needsAttention.length === 0 ? ' ov-clear' : ''}`} aria-labelledby="ov-attn-h">
              <h2 className="ov-card-title" id="ov-attn-h">
                <Icon name={data.needsAttention.length ? 'alert' : 'check'} size={14} />
                {data.needsAttention.length ? 'Needs attention' : 'All clear'}
              </h2>
              {data.needsAttention.length === 0 ? (
                <p className="ov-muted">No failed runs. Everything is humming along.</p>
              ) : (
                <ul className="ov-attn-list">
                  {data.needsAttention.map((run) => (
                    <li className="ov-attn-item" key={run.executionId}>
                      <span className="ov-attn-info">
                        <strong>{run.name}</strong>
                        <span>Run failed</span>
                      </span>
                      <Link className="btn btn-soft btn-sm" to={`/executions/${run.executionId}`}>
                        Inspect
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ov-card ov-top" aria-labelledby="ov-top-h">
              <h2 className="ov-card-title" id="ov-top-h">
                <Icon name="workflow" size={14} /> Busiest workflows
              </h2>
              {data.busiest.length === 0 ? (
                <p className="ov-muted">No runs yet.</p>
              ) : (
                <ul className="ov-top-list">
                  {data.busiest.map((workflow) => (
                    <li key={workflow.workflowId}>
                      <Link className="ov-top-row" to={`/workflows/${workflow.workflowId}/runs`}>
                        <span className="ov-top-name">{workflow.name}</span>
                        <span className="ov-top-track" aria-hidden="true">
                          <span
                            className="ov-top-fill"
                            style={{ width: `${Math.max(6, Math.round((workflow.runs / data.busiest[0]!.runs) * 100))}%` }}
                          />
                        </span>
                        <span className="ov-top-count mono">{workflow.runs}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ov-card ov-recent" aria-labelledby="ov-rec-h">
              <h2 className="ov-card-title" id="ov-rec-h">
                <Icon name="clock" size={14} /> Recent runs
              </h2>
              {data.recent.length === 0 ? (
                <p className="ov-muted">No runs yet.</p>
              ) : (
                <ul className="ov-recent-list">
                  {data.recent.map((run) => (
                    <li className="ov-recent-row" key={run.executionId}>
                      {/* Decorative: the status word is shown alongside. */}
                      <span className={`ov-run-dot ${runDot(run.status)}`} aria-hidden="true" />
                      <Link className="ov-recent-name" to={`/executions/${run.executionId}`}>
                        {run.name}
                      </Link>
                      <span className="ov-recent-when">{run.status}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Link className="ov-link" to="/operate">
                View all runs
              </Link>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
