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
 * The History tab: this step's recent runs. The workflow's executions come
 * from the read endpoint; expanding one loads its per-node logs, filtered
 * to this node, so you see exactly what this step did each time without
 * opening any external run viewer.
 */
import { useEffect, useState } from 'react';
import { api, type ExecutionSummary, type RunLog, type WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';

function shortTime(iso?: string): string {
  if (!iso) return '';
  // Trim to minute precision without a date library: "2026-07-04 11:58".
  return iso.replace('T', ' ').slice(0, 16);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Row({ execution, nodeId }: { execution: ExecutionSummary; nodeId: string }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<RunLog[]>();
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !logs) {
      setLoading(true);
      try {
        const detail = await api.execution(execution.executionId);
        setLogs(detail.logs.filter((entry) => entry.nodeId === nodeId));
      } catch {
        setLogs([]);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className={`hist-row${open ? ' open' : ''}`}>
      <button type="button" className="hist-head" aria-expanded={open} onClick={toggle}>
        <span className={`run-dot status-${execution.status}`} aria-hidden="true" />
        <span className="hist-status">{execution.status}</span>
        <span className="hist-time mono">{shortTime(execution.startTime)}</span>
      </button>
      {open && (
        <div className="hist-body">
          {loading && <p className="help">Loading</p>}
          {logs && logs.length === 0 && !loading && (
            <p className="help">This step did not run in that pass.</p>
          )}
          {logs?.map((log, index) => (
            <div className="hist-log" key={index}>
              <span className="hist-event">{(log.event ?? '').replace('workflow.node.', '')}</span>
              {log.output !== undefined && (
                <pre className="mono hist-output">{stringify(log.output)}</pre>
              )}
              {log.error !== undefined && log.error !== null && (
                <pre className="mono hist-output hist-output-error">{stringify(log.error)}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HistoryTab({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const workflowId = flow.workflowId;
  const [executions, setExecutions] = useState<ExecutionSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!workflowId) {
      setExecutions([]);
      return;
    }
    let live = true;
    api
      .workflowExecutions(workflowId)
      .then((page) => {
        if (live) setExecutions(page.items);
      })
      .catch(() => {
        if (live) setError('Could not load run history.');
      });
    return () => {
      live = false;
    };
  }, [workflowId]);

  if (!workflowId) {
    return <p className="ins-placeholder">Save and run the workflow to see its history here.</p>;
  }
  if (error) {
    return (
      <p className="field-error" role="alert">
        {error}
      </p>
    );
  }
  if (!executions) {
    return <p className="help">Loading</p>;
  }
  if (executions.length === 0) {
    return <p className="ins-placeholder">No runs yet. Use the Test tab to try this step.</p>;
  }

  return (
    <div className="hist-list">
      {executions.map((execution) => (
        <Row key={execution.executionId} execution={execution} nodeId={node.id} />
      ))}
    </div>
  );
}
