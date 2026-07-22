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
import { useEffect, useRef } from 'react';
import { Modal } from '../builder/inspector/Modal.js';

/**
 * A guard before destructive actions. Escape and the overlay cancel (Modal
 * handles both); the confirm button takes focus so Enter confirms.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Remove',
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  confirmLabel?: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Focus the confirm button after Modal's own panel focus runs.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <Modal title={title} onClose={onCancel}>
      {body && <p className="confirm-body">{body}</p>}
      <div className="confirm-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          ref={confirmRef}
          className="btn btn-danger"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
