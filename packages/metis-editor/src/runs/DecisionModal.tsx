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
 * Confirming an approval decision.
 *
 * This replaced a window.prompt, which was wrong twice over. It wore the
 * operating system's clothes rather than the product's, and more importantly
 * it showed nothing but a title: the values the decision actually turns on
 * were back on the page behind it. An approval gate exists so a person looks
 * at the numbers before the money moves, so the numbers belong in front of
 * them at the moment they decide.
 *
 * The other thing a prompt could not do is insist. Rejecting says "say why"
 * and a prompt will happily take an empty string, which leaves an audit line
 * that records a refusal and no reason. Here the reject button stays disabled
 * until there is one.
 */
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../builder/inspector/Modal.js';
import type { ReviewItem } from './review-queue.js';

export function DecisionModal({
  item,
  decision,
  busy,
  onCancel,
  onConfirm,
}: {
  item: ReviewItem;
  decision: 'approved' | 'rejected';
  busy: boolean;
  onCancel(): void;
  onConfirm(reason: string): void;
}) {
  const [reason, setReason] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const rejecting = decision === 'rejected';
  const confirmLabel = rejecting ? 'Reject' : 'Approve';
  // A reason is the whole value of a rejection after the fact. Approvals can
  // stand on the approver's name alone, so a note there stays optional.
  const needsReason = rejecting && reason.trim() === '';

  useEffect(() => {
    box.current?.focus();
  }, []);

  return (
    <Modal title={rejecting ? 'Reject this request' : 'Approve this request'} onClose={onCancel}>
      <div className="decision">
        <p className="decision-what">{item.title}</p>
        <p className="decision-where">
          in <span className="decision-flow">{item.workflowName}</span>
        </p>

        {item.fields.length > 0 && (
          <dl className="review-fields decision-facts">
            {item.fields.map((field) => (
              <div key={`${field.label}-${field.value}`}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {item.escalated && (
          <p className="decision-flag">
            Raised again: the first deadline passed without an answer.
          </p>
        )}
        {item.refused && <p className="decision-flag">{item.refused}</p>}

        <label className="decision-reason" htmlFor="decision-reason">
          {rejecting ? 'Why are you rejecting this?' : 'Note (optional)'}
        </label>
        <textarea
          id="decision-reason"
          ref={box}
          className="decision-input"
          rows={3}
          value={reason}
          placeholder={rejecting ? 'This will be recorded against the run' : 'Anything worth recording'}
          onChange={(event) => setReason(event.target.value)}
        />

        <p className="decision-note">
          Recorded against the run as your decision, with your name and the time.
        </p>

        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${rejecting ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy || needsReason}
            title={needsReason ? 'A rejection needs a reason' : undefined}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? 'Sending' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
