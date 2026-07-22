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
import { HEALTH_LABEL, type HealthState } from './health.js';

/** A "Test" button plus the resulting verdict, used inside the modals. */
export function TestRow({
  health,
  onTest,
  label,
}: {
  health: HealthState;
  onTest(): void;
  label: string;
}) {
  return (
    <div className="modal-test">
      <button type="button" className="btn btn-sm" onClick={onTest} disabled={health === 'testing'}>
        {health === 'testing' ? 'Testing…' : label}
      </button>
      {health && health !== 'testing' && (
        <span className={`conn-badge ${health.ok ? 'conn-ok' : 'conn-warn'}`} title={health.message}>
          {HEALTH_LABEL[health.status]}
          {health.message ? <span className="conn-badge-msg"> · {health.message}</span> : ''}
        </span>
      )}
    </div>
  );
}
