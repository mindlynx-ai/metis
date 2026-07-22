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
import { createPortal } from 'react-dom';
import { useToasts, type ToastVariant } from '../toast-store.js';
import { Icon, type IconName } from './Icon.js';

const VARIANT_ICON: Record<ToastVariant, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'info',
};

/** The toast host: mounted once in the shell, announced politely. */
export function Toasts() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.variant}`}>
          <Icon name={VARIANT_ICON[t.variant]} className="toast-icon" />
          <span className="toast-message">{t.message}</span>
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
