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
 * The Policy tab: how this step behaves when it runs, in plain terms.
 * "Where it runs" (for a step with a cloud version), retries, the wait
 * between them, a timeout, and what to do on failure. Values persist on
 * the node (data.policy / data.metadata.cloudRouting) and the engine
 * enforces them: retries/backoff/timeout wrap the step's execution, and
 * "continue" lets the run carry on past a failure.
 */
import { useEffect, useState } from 'react';
import type { CatalogueEntry, NodePolicy, WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import { useUplift } from '../../uplift-store.js';

type CloudMode = 'local' | 'cloud' | 'auto';
type ThresholdUnit = 'mb' | 'krows';

interface NodeCloudRouting {
  mode?: CloudMode;
  thresholdBytes?: number;
  /** Display sugar only; the engine reads thresholdBytes. */
  thresholdUnit?: ThresholdUnit;
}

// ponytail: a row is budgeted at ~1KB, so "MB" and "thousand rows" resolve
// to the same byte multiplier; refine per-connector if sizing ever matters.
const BYTES_PER_UNIT = 1_000_000;

const MODE_LABELS: { mode: CloudMode; label: string }[] = [
  { mode: 'local', label: 'On this computer' },
  { mode: 'cloud', label: 'In the cloud' },
  { mode: 'auto', label: 'Automatic' },
];

/**
 * The "Where it runs" segmented control. Automatic requires a size first:
 * there is deliberately no default threshold, and the choice is not saved
 * until one is set ("Set a size first" on blur until then).
 */
function WhereItRuns({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const routing = (node.data?.metadata?.cloudRouting ?? {}) as NodeCloudRouting;
  const workflowCloud = Boolean(flow.cloudRouting?.enabled);
  const savedMode: CloudMode = routing.mode ?? 'local';

  // Automatic picked but no size yet: shown active, not yet saved.
  const [pendingAuto, setPendingAuto] = useState(false);
  const [sizeText, setSizeText] = useState(
    routing.thresholdBytes !== undefined ? String(routing.thresholdBytes / BYTES_PER_UNIT) : '',
  );
  const [unit, setUnit] = useState<ThresholdUnit>(routing.thresholdUnit ?? 'mb');
  const [sizeError, setSizeError] = useState(false);
  useEffect(() => {
    // Selection changed to another node: mirror its stored routing.
    setPendingAuto(false);
    setSizeText(
      routing.thresholdBytes !== undefined ? String(routing.thresholdBytes / BYTES_PER_UNIT) : '',
    );
    setUnit(routing.thresholdUnit ?? 'mb');
    setSizeError(false);
    // Keyed by node identity only: mid-edit keystrokes must not reset it.
  }, [node.id]);

  const activeMode: CloudMode = pendingAuto ? 'auto' : savedMode;
  const showThreshold = activeMode === 'auto';

  const write = (next: NodeCloudRouting) => flow.updateMetadata(node.id, { cloudRouting: next });

  const pick = (mode: CloudMode) => {
    setSizeError(false);
    if (mode !== 'auto') {
      setPendingAuto(false);
      write({ mode });
      return;
    }
    const size = Number(sizeText);
    if (sizeText.trim() !== '' && Number.isFinite(size) && size > 0) {
      write({ mode: 'auto', thresholdBytes: size * BYTES_PER_UNIT, thresholdUnit: unit });
    } else {
      // No default: Automatic waits for a size before it is saved.
      setPendingAuto(true);
    }
  };

  const commitSize = (text: string, nextUnit: ThresholdUnit) => {
    const size = Number(text);
    if (text.trim() === '' || !Number.isFinite(size) || size <= 0) {
      setSizeError(true);
      return;
    }
    setSizeError(false);
    setPendingAuto(false);
    write({ mode: 'auto', thresholdBytes: size * BYTES_PER_UNIT, thresholdUnit: nextUnit });
  };

  const seg = (
    <>
      <span className="field-label insp-label" id="policy-where">
        Where it runs
      </span>
      <div className="seg" role="radiogroup" aria-labelledby="policy-where">
        {MODE_LABELS.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={activeMode === mode}
            className={`seg-btn${activeMode === mode ? ' active' : ''}`}
            onClick={() => pick(mode)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );

  if (!workflowCloud) {
    return (
      <div className="field where-runs">
        <div className="insp-disabled">{seg}</div>
        <p className="lock-note">Turn on cloud for this workflow first.</p>
      </div>
    );
  }

  return (
    <div className="field where-runs">
      {seg}
      {showThreshold && (
        <div className={`threshold${sizeError ? ' error' : ''}`}>
          <div className="threshold-row">
            <span className="threshold-above">Above</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="e.g. 50"
              aria-label="Size"
              aria-invalid={sizeError || undefined}
              value={sizeText}
              onChange={(event) => setSizeText(event.target.value)}
              onBlur={() => commitSize(sizeText, unit)}
            />
            <select
              aria-label="Unit"
              value={unit}
              onChange={(event) => {
                const nextUnit = event.target.value as ThresholdUnit;
                setUnit(nextUnit);
                if (sizeText.trim() !== '') commitSize(sizeText, nextUnit);
              }}
            >
              <option value="mb">MB</option>
              <option value="krows">thousand rows</option>
            </select>
          </div>
          {sizeError && <span className="err">Set a size first</span>}
          <span className="help">Above this size, this step runs in the cloud.</span>
        </div>
      )}
    </div>
  );
}

function NumberField({
  id,
  label,
  help,
  value,
  suffix,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: number | undefined;
  suffix?: string;
  onChange(next: number | undefined): void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="num-suffix">
        <input
          id={id}
          type="number"
          min={0}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
      <div className="help">{help}</div>
    </div>
  );
}

export function PolicyTab({ node, entry }: { node: WorkflowNode; entry?: CatalogueEntry }) {
  const flow = useFlow();
  const policy: NodePolicy = node.data?.policy ?? {};
  const set = (patch: NodePolicy) => flow.updatePolicy(node.id, patch);
  // "Where it runs" exists only for a step with a cloud version, and never
  // when the kill switch has this instance cloud-free.
  const cloud = useUplift((state) => state.cloud);
  const upliftable = entry?.execution === 'both' && Boolean(entry.entitlement) && cloud !== 'disabled';

  return (
    <div className="policy-tab">
      {upliftable && <WhereItRuns node={node} />}
      <NumberField
        id="policy-retries"
        label="Retries"
        help="How many times to try again if this step fails. For HTTP steps, set retries here rather than in the step config so they are not multiplied."
        value={policy.retries}
        suffix="times"
        onChange={(retries) => set({ retries })}
      />
      <NumberField
        id="policy-backoff"
        label="Wait between retries"
        help="Pause before each retry."
        value={policy.backoffSeconds}
        suffix="seconds"
        onChange={(backoffSeconds) => set({ backoffSeconds })}
      />
      <NumberField
        id="policy-timeout"
        label="Timeout"
        help="Give up if the step runs longer than this."
        value={policy.timeoutSeconds}
        suffix="seconds"
        onChange={(timeoutSeconds) => set({ timeoutSeconds })}
      />

      <div className="field">
        <span className="field-label" id="policy-onfailure">
          On failure
        </span>
        <div className="seg" role="group" aria-labelledby="policy-onfailure">
          {(['halt', 'continue'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`seg-btn${(policy.onFailure ?? 'halt') === option ? ' active' : ''}`}
              aria-pressed={(policy.onFailure ?? 'halt') === option}
              onClick={() => set({ onFailure: option })}
            >
              {option === 'halt' ? 'Stop the run' : 'Carry on'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
