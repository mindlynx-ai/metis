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
 * One execution, drilled all the way down: status, timing, the per-node
 * timeline, its FAMILY (parent / child runs - loop iterations are real child
 * runs), pending-activity retries ("why is my run stuck"), and - when the run
 * is parked on a signal - a Send Signal form prefilled with what it waits
 * for. Deep-linkable from the Operate board (Temporal's workflowId IS the
 * Metis executionId).
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { api, type ExecutionDetail, type ExecutionInsight } from '../api.js';
import { Icon } from '../ui/Icon.js';
import { RunTimeline } from './RunTimeline.js';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : undefined);

function durationOf(meta: ExecutionDetail['meta']): string | undefined {
  if (!meta.startTime || !meta.endTime) return undefined;
  const ms = new Date(meta.endTime).getTime() - new Date(meta.startTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The waiting explanation + prefilled signal form for a parked run. */
function WaitingPanel({
  executionId,
  insight,
  onSignalled,
}: {
  executionId: string;
  insight: ExecutionInsight;
  onSignalled(): void;
}) {
  const waitingOn = insight.whereabouts?.waitingOn;
  const [signalType, setSignalType] = useState(waitingOn?.signalType ?? '');
  const [params, setParams] = useState('{}');
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');
  if (insight.whereabouts?.runState !== 'waiting') return null;

  let reason = 'waiting for an outside event';
  if (waitingOn?.signalType) reason = `waiting for signal: ${waitingOn.signalType}`;
  else if (waitingOn?.until) reason = `waiting until ${new Date(waitingOn.until).toLocaleString()}`;

  const send = async () => {
    let parsed: unknown = {};
    try {
      parsed = params.trim() === '' ? {} : JSON.parse(params);
    } catch {
      setState('error');
      return;
    }
    setState('sending');
    try {
      await api.signalExecution(executionId, signalType, parsed);
      onSignalled();
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <section className="exec-waiting" aria-label="Waiting">
      <span className="status status-waiting">waiting</span>
      <span className="exec-waiting-reason">{reason}</span>
      {waitingOn?.signalType !== undefined || waitingOn?.until === undefined ? (
        <div className="signal-form">
          <input
            aria-label="Signal name"
            value={signalType}
            placeholder="signal name"
            onChange={(event) => setSignalType(event.target.value)}
          />
          <input
            aria-label="Signal payload (JSON)"
            className="mono"
            value={params}
            onChange={(event) => setParams(event.target.value)}
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={state === 'sending' || signalType === ''} onClick={() => void send()}>
            Send signal
          </button>
          {state === 'error' && <span className="field-error">payload must be JSON</span>}
        </div>
      ) : null}
    </section>
  );
}

export function ExecutionPage() {
  const { executionId } = useParams();
  const [detail, setDetail] = useState<ExecutionDetail>();
  const [insight, setInsight] = useState<ExecutionInsight>();
  const [missing, setMissing] = useState(false);

  // Where the user came from (Operate or a workflow's runs page); the back
  // button returns there instead of a hardcoded destination.
  const location = useLocation();
  const backTo = (location.state as { from?: string } | null)?.from ?? '/operate';
  const backLabel = backTo.startsWith('/workflows') ? 'Back to runs' : 'Back to Operate';

  const load = () => {
    if (!executionId) return;
    api
      .execution(executionId)
      .then(setDetail)
      .catch(() => setMissing(true));
    api
      .executionInsight(executionId)
      .then(setInsight)
      .catch(() => undefined);
  };
  useEffect(load, [executionId]);

  if (missing) {
    return (
      <main className="shell-main" aria-label="Execution detail">
        <div className="empty-card">
          <p>No stored detail for this run.</p>
          <Link className="btn" to={backTo}>
            {backLabel}
          </Link>
        </div>
      </main>
    );
  }
  if (!detail) return <main className="shell-main" aria-label="Execution detail" />;

  const { meta, logs } = detail;
  const duration = durationOf(meta);
  const pending = (insight?.pendingActivities ?? []).filter((activity) => (activity.attempt ?? 0) > 1);
  const children = insight?.children ?? [];

  const download = () => {
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${meta.executionId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="shell-main exec-page" aria-label="Execution detail">
      <div className="page-head">
        <div>
          <h1 className="page-title">{insight?.workflowName ?? 'Run detail'}</h1>
          <p className="exec-id mono">{meta.executionId}</p>
        </div>
        <div className="exec-actions">
          <Link
            className="btn"
            to={`/workflows/${encodeURIComponent(String(meta.workflowId))}/edit?run=${encodeURIComponent(meta.executionId)}`}
          >
            View on canvas
          </Link>
          <button type="button" className="btn" onClick={download}>
            Download JSON
          </button>
          <Link className="btn" to={backTo}>
            {backLabel}
          </Link>
        </div>
      </div>
      <div className="exec-meta">
        <span className={`status status-${meta.status}`}>{meta.status}</span>
        {when(meta.startTime) && <span>Started {when(meta.startTime)}</span>}
        {when(meta.endTime) && <span>Ended {when(meta.endTime)}</span>}
        {duration && <span>Took {duration}</span>}
        <span className="mono">{meta.workflowId}</span>
        {meta.definitionVersion !== undefined && (
          <span className="ver-chip" title="The definition version this run executed">
            v{meta.definitionVersion}·c{meta.definitionChangeset ?? 0}
          </span>
        )}
      </div>

      {meta.degraded && (
        <div className="degraded-banner static" role="status">
          <Icon name="cloud-off" size={16} />
          <span>
            <b>The cloud wasn&apos;t reachable</b>, so one step ran on your computer instead. The
            run still completed.
          </span>
          <Link
            className="btn btn-sm"
            to={`/workflows/${encodeURIComponent(String(meta.workflowId))}/edit?run=${encodeURIComponent(meta.executionId)}`}
          >
            See which step
          </Link>
        </div>
      )}

      {insight && executionId && (
        <WaitingPanel executionId={executionId} insight={insight} onSignalled={load} />
      )}

      {pending.length > 0 && (
        <section className="exec-pending" aria-label="Pending retries">
          <h2 className="op-section-title">Retrying steps</h2>
          {pending.map((activity, index) => (
            <p key={index} className="exec-pending-row">
              <span className="mono">{activity.type ?? 'step'}</span> - attempt {activity.attempt}
              {activity.maximumAttempts ? ` of ${activity.maximumAttempts}` : ''}
              {activity.lastFailure && <span className="field-error"> last failure: {activity.lastFailure}</span>}
            </p>
          ))}
        </section>
      )}

      {(insight?.parentExecutionId || children.length > 0) && (
        <section className="exec-family" aria-label="Related runs">
          <h2 className="op-section-title">Related runs</h2>
          {insight?.parentExecutionId && (
            <p className="exec-family-row">
              Parent:{' '}
              <Link className="mono" to={`/executions/${encodeURIComponent(insight.parentExecutionId)}`}>
                {insight.parentExecutionId}
              </Link>
            </p>
          )}
          {children.map((child) => (
            <p key={child.executionId} className="exec-family-row">
              <span className={`status status-${child.status}`}>{child.status}</span>{' '}
              <Link className="mono" to={`/executions/${encodeURIComponent(child.executionId)}`}>
                {child.executionId}
              </Link>
            </p>
          ))}
        </section>
      )}

      <section className="timeline" aria-label="Run steps">
        <RunTimeline logs={logs} />
      </section>
    </main>
  );
}
