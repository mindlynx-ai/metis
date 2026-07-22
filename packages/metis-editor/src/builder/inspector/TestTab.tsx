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
 * The Test tab: run JUST this step (sent inline as a one-node graph) with a
 * sample input, and show what it returns. The step's own configuration - what
 * it will send - is shown as JSON so the test is transparent. A short poll of
 * the execution read endpoint surfaces the outcome without leaving the panel.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type RunLog, type WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';

type Phase = 'idle' | 'running' | 'done' | 'error';

const POLL_LIMIT = 15;
const POLL_MS = 600;

export function TestTab({
  node,
  onSave,
}: {
  node: WorkflowNode;
  onSave?: () => Promise<string | undefined>;
}) {
  const flow = useFlow();
  const [input, setInput] = useState('{}');
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<string>();
  const [nodeLog, setNodeLog] = useState<RunLog>();
  const [message, setMessage] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const poll = async (executionId: string, tries: number) => {
    try {
      const detail = await api.execution(executionId);
      setStatus(detail.meta.status);
      const mine = detail.logs.filter((entry) => entry.nodeId === node.id);
      const last = mine[mine.length - 1];
      if (last) setNodeLog(last);
      if (detail.meta.status !== 'running' || tries >= POLL_LIMIT) {
        setPhase('done');
        return;
      }
    } catch {
      // A not-yet-visible execution just means keep waiting.
    }
    timer.current = setTimeout(() => void poll(executionId, tries + 1), POLL_MS);
  };

  const run = async () => {
    setMessage(undefined);
    setNodeLog(undefined);
    setStatus(undefined);
    let parsed: unknown = {};
    if (input.trim() !== '') {
      try {
        parsed = JSON.parse(input);
      } catch {
        setPhase('error');
        setMessage('Input must be valid JSON.');
        return;
      }
    }
    setPhase('running');
    try {
      const workflowId = (onSave ? await onSave() : await flow.save()) ?? flow.workflowId;
      if (!workflowId) throw new ApiError(400, 'save the workflow first');
      const started = await api.startExecution({
        workflowId,
        // Test THIS step alone: send it as a one-node graph, not the whole flow.
        definition: { nodes: [node], edges: [] },
        input: parsed,
      });
      setStatus(started.status ?? 'running');
      void poll(started.executionId, 0);
    } catch (cause) {
      setPhase('error');
      setMessage(cause instanceof ApiError ? cause.message : 'could not start the test run');
    }
  };

  const config = (node.data?.config ?? {}) as Record<string, unknown>;
  const sends = 'params' in config ? config.params : config;
  // A step can "complete" while its HTTP call failed (ok:false / 4xx / 5xx);
  // surface that as an error so a bad send is not mistaken for success.
  const httpError = httpErrorOf(nodeLog?.output);
  // How big the result is - so you SEE the size (and any truncation) before it
  // becomes a problem downstream.
  const size = outputSize(nodeLog?.output);

  return (
    <div className="test-tab">
      <span className="field-label">What this step sends</span>
      <p className="help">This step&apos;s configuration, as it will be sent.</p>
      <pre className="mono test-preview" data-testid="test-sends">
        {stringify(sends ?? {})}
      </pre>

      <label className="field-label" htmlFor="test-input">
        Sample input
      </label>
      <p className="help">Optional data for any upstream variables, as JSON.</p>
      <textarea
        id="test-input"
        className="mono"
        rows={4}
        value={input}
        aria-label="Sample input JSON"
        onChange={(event) => setInput(event.target.value)}
      />
      <button
        type="button"
        className="btn btn-primary test-run"
        onClick={run}
        disabled={phase === 'running'}
      >
        {phase === 'running' ? 'Testing' : 'Test this step'}
      </button>

      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}

      {status && (
        <div className="test-result">
          <div className="test-status">
            <span className={`run-dot status-${status}`} aria-hidden="true" />
            Run {status}
          </div>
          {nodeLog ? (
            <>
              <div className="test-result-label">
                {httpError ? 'This step returned an error' : `This step ${logVerb(nodeLog)}`}
              </div>
              {httpError && (
                <p className="field-error" role="alert">
                  {httpError}
                </p>
              )}
              {size && <div className="test-size">{formatSize(size)}</div>}
              {size?.truncated && (
                <p className="field-warn" role="status">
                  Showing the first {size.rows} rows - the free step caps results at ~1,000 rows /
                  256 KB so they fit through the workflow. Larger datasets run in Helix.
                </p>
              )}
              {nodeLog.output !== undefined && (
                <pre className={`mono test-output${httpError ? ' test-output-error' : ''}`}>
                  {stringify(nodeLog.output)}
                </pre>
              )}
              {nodeLog.error !== undefined && nodeLog.error !== null && (
                <pre className="mono test-output test-output-error">{stringify(nodeLog.error)}</pre>
              )}
            </>
          ) : (
            phase === 'done' && <p className="help">This step did not run in that pass.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The result's size (rows + KB) and whether it was capped, for the size line. */
export function outputSize(
  output: unknown,
): { rows?: number; kb: string; truncated: boolean } | undefined {
  if (output === undefined || output === null) return undefined;
  let json: string;
  try {
    json = JSON.stringify(output);
  } catch {
    return undefined;
  }
  if (!json) return undefined;
  const bytes = new TextEncoder().encode(json).length;
  const result = output as { rowCount?: number; truncated?: boolean; rows?: unknown[] };
  let rows: number | undefined;
  if (typeof result.rowCount === 'number') rows = result.rowCount;
  else if (Array.isArray(result.rows)) rows = result.rows.length;
  const kb = (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0);
  return { rows, kb, truncated: result.truncated === true };
}

/** "247 rows · 34 KB", or just "34 KB" when the output is not a row set. */
function formatSize(size: { rows?: number; kb: string }): string {
  if (size.rows === undefined) return `${size.kb} KB`;
  return `${size.rows} ${size.rows === 1 ? 'row' : 'rows'} · ${size.kb} KB`;
}

function logVerb(log: RunLog): string {
  if (log.outcome === 'failed' || (log.event ?? '').endsWith('failed')) return 'failed';
  if (log.outcome === 'completed' || (log.event ?? '').endsWith('completed')) return 'returned';
  return 'ran';
}

/**
 * A message when a step's output is a failed HTTP result (ok:false or a 4xx/5xx
 * status), else undefined. The connector/HTTP node completes on any response, so
 * the failure lives in the payload, not the run outcome.
 */
export function httpErrorOf(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const result = output as {
    ok?: boolean;
    status?: number;
    data?: { message?: unknown; error?: unknown };
  };
  const failed = result.ok === false || (typeof result.status === 'number' && result.status >= 400);
  if (!failed) return undefined;
  const detail = result.data?.message ?? result.data?.error;
  const reason = typeof detail === 'string' ? detail : undefined;
  return reason
    ? `${result.status ?? ''} ${reason}`.trim()
    : `The request returned ${result.status ?? 'an error'}.`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
