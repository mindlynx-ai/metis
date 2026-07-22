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
 * The per-node story of a run, shared by the runs viewer and the execution
 * detail page: each log line with its step, event and time; failures show
 * their error message; retried steps show the attempt count; outputs
 * pretty-print in a bounded scroll area. When the workflow had cloud
 * routing switched on, the consent receipt leads the timeline: a system
 * row, distinct from the steps and never dismissible - the receipt of
 * the promise.
 */
import { type RunLog } from '../api.js';
import { Icon } from '../ui/Icon.js';

const timeOf = (iso?: string): string => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB');
};

/** The consent receipt (event workflow.cloud.routing, sequence 1). */
function ConsentReceipt({ log }: { log: RunLog }) {
  const allowed = log.decision === 'allowed';
  return (
    <div className={`audit-row${allowed ? '' : ' kept'}`} role="note">
      <Icon name={allowed ? 'cloud-check' : 'computer'} size={15} />
      <span>
        {allowed ? (
          <>
            <b>You allowed cloud processing for this workflow</b>
            {log.scope !== 'run' && <> {'·'} for all future runs</>}
          </>
        ) : (
          <b>You kept this workflow on this computer</b>
        )}
      </span>
      <span className="when mono">{timeOf(log.at)}</span>
    </div>
  );
}

export function RunTimeline({ logs }: { logs: RunLog[] }) {
  const receipt = logs.find((log) => log.event === 'workflow.cloud.routing');
  return (
    <>
      {receipt && <ConsentReceipt log={receipt} />}
      {/* Node-set rows (orphaned branches) have no single step to render. */}
      {logs.filter((log) => log.nodeId).map((log, index) => (
        <div
          key={log.sequence ?? index}
          className={`step${(log.event ?? '').includes('failed') ? ' failed' : ''}`}
        >
          <strong>{log.nodeId ?? 'run'}</strong> {log.event}{' '}
          <span className="mono">{log.at ?? ''}</span>
          {log.binding === 'local-degraded' && (
            <span className="step-tag">Ran here instead</span>
          )}
          {(log.attempts ?? 1) > 1 && (
            <span className="step-attempts">{log.attempts} attempts</span>
          )}
          {log.error?.message && <div className="step-error">{log.error.message}</div>}
          {log.output !== undefined && (
            <pre className="step-output mono">{JSON.stringify(log.output, null, 2)}</pre>
          )}
        </div>
      ))}
    </>
  );
}
