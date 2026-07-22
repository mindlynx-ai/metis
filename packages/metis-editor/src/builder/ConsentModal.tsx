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
 * The consent gate: shown once, at run time, the first time a workflow
 * with cloud routing switched on is about to run - never while editing.
 * Both actions are affirmative (there is no "Cancel"); Escape and the
 * overlay resolve to the safe default, keep it on this computer. The
 * checkbox turns a one-run yes into a remembered one. Either choice is
 * written to the run's history as a receipt.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon.js';

export type ConsentChoice = { decision: 'cloud'; remember: boolean } | { decision: 'local' };

export function ConsentModal({ onChoose }: { onChoose(choice: ConsentChoice): void }) {
  const [remember, setRemember] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primary.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Esc = keep it on this computer: closing is never silent, it decides.
      if (event.key === 'Escape') onChoose({ decision: 'local' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onChoose]);

  return createPortal(
    <div className="modal-overlay" onMouseDown={() => onChoose({ decision: 'local' })}>
      <div
        className="modal consent-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="consent-head">
          <span className="consent-disc" aria-hidden="true">
            <Icon name="cloud" size={22} />
          </span>
          <h2 className="consent-title" id="consent-title">
            Send data to the cloud?
          </h2>
        </div>

        <div className="consent-rows">
          <div className="consent-row">
            <span className="row-ico" aria-hidden="true">
              <Icon name="doc" size={15} />
            </span>
            <p className="row-txt">
              <b>What leaves</b>Only the data this step works on {'\u2014'} nothing else on your
              computer.
            </p>
          </div>
          <div className="consent-row">
            <span className="row-ico" aria-hidden="true">
              <Icon name="cloud" size={15} />
            </span>
            <p className="row-txt">
              <b>Where it goes</b>Helix Cloud, under your account. It&apos;s processed and the
              result comes back to this run.
            </p>
          </div>
          <div className="consent-row">
            <span className="row-ico" aria-hidden="true">
              <Icon name="undo" size={15} />
            </span>
            <p className="row-txt">
              <b>You stay in control</b>You can switch any step back to this computer at any time.
            </p>
          </div>
        </div>

        <label className="consent-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />{' '}
          Don&apos;t ask again for this workflow
        </label>
        <p className="consent-note">Your choice is saved in this run&apos;s history.</p>

        <div className="consent-actions">
          <button type="button" className="btn" onClick={() => onChoose({ decision: 'local' })}>
            Keep it on this computer
          </button>
          <button
            type="button"
            className="btn btn-primary"
            ref={primary}
            onClick={() => onChoose({ decision: 'cloud', remember })}
          >
            Send to the cloud
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
