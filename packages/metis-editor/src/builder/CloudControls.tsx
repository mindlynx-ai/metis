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
 * The builder's cloud furniture: the per-workflow "Allow cloud" modal
 * (opened from the bar's cloud button, Versions pattern) and the degraded
 * banner shown over the canvas when a run's cloud step ran here instead.
 */
import { useFlow } from '../flow-store.js';
import { Icon } from '../ui/Icon.js';
import { Modal } from './inspector/Modal.js';

/** "Cloud for this workflow": the toggle + the remembered-consent reset. */
export function CloudWorkflowModal({ onClose }: { onClose(): void }) {
  const flow = useFlow();
  return (
    <Modal title="Cloud for this workflow" onClose={onClose}>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={Boolean(flow.cloudRouting?.enabled)}
          onChange={(event) =>
            flow.setCloudRouting({ ...flow.cloudRouting, enabled: event.target.checked })
          }
        />
        <span className="switch" aria-hidden="true" />
        <span className="switch-txt">
          <b>Allow cloud for this workflow</b>
          <span>
            We&apos;ll always ask before anything leaves this computer for the first time.
          </span>
        </span>
      </label>
      {flow.cloudRouting?.consentAt && (
        <div className="reset-line">
          You said &ldquo;don&apos;t ask again&rdquo; on{' '}
          {new Date(flow.cloudRouting.consentAt).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
          .{' '}
          <button
            type="button"
            className="reset-link"
            onClick={() => flow.setCloudRouting({ enabled: Boolean(flow.cloudRouting?.enabled) })}
          >
            Reset cloud permission
          </button>
        </div>
      )}
    </Modal>
  );
}

/** "The cloud wasn't reachable" - informative, never alarming; the run stayed
 *  green and amber is only the modifier. */
export function DegradedBanner({
  belowReplay,
  onSeeStep,
}: {
  belowReplay: boolean;
  onSeeStep(): void;
}) {
  return (
    <div className={`degraded-banner${belowReplay ? ' below-replay' : ''}`} role="status">
      <Icon name="cloud-off" size={16} />
      <span>
        <b>The cloud wasn&apos;t reachable</b>, so one step ran on your computer instead. The run
        still completed.
      </span>
      <button type="button" className="btn btn-sm" onClick={onSeeStep}>
        See which step
      </button>
    </div>
  );
}
