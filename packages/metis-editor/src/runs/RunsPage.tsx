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
 * The execution viewer: run history and per-node logs from
 * the gateway, live status streamed over the run-status WebSocket, and
 * the raw Temporal Web UI one click away.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { io, type Socket } from 'socket.io-client';
import { api, getToken, type ExecutionSummary, type RunLog } from '../api.js';
import { Icon } from '../ui/Icon.js';
import { RunTimeline } from './RunTimeline.js';

interface LiveEvent {
  name: string;
  executionId?: string;
  nodeId?: string;
  timestamp: string;
}

const TEMPORAL_UI_URL = import.meta.env.VITE_TEMPORAL_UI_URL ?? 'http://localhost:8233';

export function RunsPage() {
  const { workflowId } = useParams();
  const [runs, setRuns] = useState<ExecutionSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const socketRef = useRef<Socket | undefined>(undefined);

  const refreshRuns = useCallback(async () => {
    if (!workflowId) return;
    const page = await api.workflowExecutions(workflowId);
    setRuns(page.items);
  }, [workflowId]);

  const openRun = useCallback(async (executionId: string) => {
    setSelected(executionId);
    setLiveEvents([]);
    try {
      const execution = await api.execution(executionId);
      setLogs(execution.logs);
    } catch {
      setLogs([]);
    }
    socketRef.current?.emit('join', { room: `execution:${executionId}` });
  }, []);

  useEffect(() => {
    refreshRuns().catch(() => setRuns([]));
    const socket = io({
      path: '/ws/workflows',
      auth: { token: getToken() ?? '' },
      transports: ['websocket'],
    });
    socketRef.current = socket;
    // Join the workflow room so every run of this workflow streams in,
    // not only a run that has been opened.
    const joinWorkflowRoom = () => {
      if (workflowId) socket.emit('join', { room: `workflow:${workflowId}` });
    };
    socket.on('connect', joinWorkflowRoom);
    joinWorkflowRoom();
    socket.on('workflow-event', (event: LiveEvent) => {
      setLiveEvents((current) => [...current, event]);
      if (event.name.startsWith('workflow.execution.')) {
        refreshRuns().catch(() => undefined);
      }
    });
    return () => {
      socket.close();
    };
  }, [refreshRuns, workflowId]);

  const liveStatus = (executionId: string): string | undefined => {
    const relevant = liveEvents.filter((event) => event.executionId === executionId);
    const last = relevant.at(-1);
    if (!last) return undefined;
    if (last.name === 'workflow.execution.completed') return 'completed';
    if (last.name === 'workflow.execution.failed') return 'failed';
    if (last.name === 'workflow.execution.cancelled') return 'cancelled';
    return 'running';
  };

  return (
    <main className="runs" aria-label="Workflow runs">
      <header className="page-hero">
        <div>
          <h1 className="page-title">Runs</h1>
          <p className="page-hero-sub">
            Every run of <span className="mono">{workflowId}</span>, with each step as it
            happened. Pick a run to see its story.
          </p>
        </div>
        <Link className="btn" to={`/workflows/${workflowId}/edit`}>
          <Icon name="pencil" size={14} /> Open in builder
        </Link>
      </header>
      {runs.length === 0 && (
        <div className="conn-empty">
          <div className="conn-empty-mark" aria-hidden="true">
            <Icon name="play" size={28} />
          </div>
          <h2>No runs yet</h2>
          <p>Press Run in the builder and the run lands here, step by step.</p>
          <Link className="btn btn-primary" to={`/workflows/${workflowId}/edit`}>
            Open the builder
          </Link>
        </div>
      )}
      {runs.map((run) => {
        const status = liveStatus(run.executionId) ?? run.status;
        return (
          <button
            type="button"
            key={run.executionId}
            className={`run-row${selected === run.executionId ? ' selected' : ''}`}
            data-status={status}
            onClick={() => {
              openRun(run.executionId).catch(() => undefined);
            }}
          >
            <span className={`run-dot status-${status}`} />
            <span className="rid">{run.executionId}</span>
            {run.degraded ? (
              <span
                className="mini-degraded"
                role="img"
                aria-label="One step ran on this computer instead of the cloud"
                title="One step ran on this computer instead of the cloud"
              >
                <Icon name="cloud-off" size={14} />
              </span>
            ) : (
              <span className="mini-slot" />
            )}
            <span className="when">{run.startTime}</span>
            <span className={`run-status ${status}`}>{status.toUpperCase()}</span>
          </button>
        );
      })}

      {selected && (
        <section className="timeline" aria-label="Run detail">
          <RunTimeline logs={logs} />
          {liveEvents
            .filter((event) => event.executionId === selected)
            .map((event, index) => (
              <div key={`live-${index}`} className="step live">
                <strong>{event.nodeId ?? 'run'}</strong> {event.name}{' '}
                <span className="mono">{event.timestamp}</span>
              </div>
            ))}
          <p>
            <Link className="btn btn-sm" to={`/executions/${selected}`}>
              Open the full detail page
            </Link>
          </p>
        </section>
      )}

      <p className="temporal-row">
        <a className="temporal-link" href={TEMPORAL_UI_URL} target="_blank" rel="noreferrer">
          Open the raw Temporal view
        </a>
      </p>
    </main>
  );
}
