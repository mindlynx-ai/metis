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
 * Transient feedback (saves, runs, removals). Toasts auto-dismiss (errors
 * linger longer), the queue stays bounded, and pages import the tiny `toast`
 * facade rather than the store. Rendered by ui/Toasts.tsx.
 */
import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push(variant: ToastVariant, message: string, durationMs?: number): number;
  dismiss(id: number): void;
}

const DEFAULT_MS = 4000;
const ERROR_MS = 8000;
const MAX_TOASTS = 4;

let nextId = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(variant, message, durationMs = DEFAULT_MS) {
    nextId += 1;
    const id = nextId;
    set({ toasts: [...get().toasts, { id, variant, message }].slice(-MAX_TOASTS) });
    setTimeout(() => get().dismiss(id), durationMs);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** The surface pages use: toast.success('Workflow saved'). */
export const toast = {
  success: (message: string) => useToasts.getState().push('success', message),
  error: (message: string) => useToasts.getState().push('error', message, ERROR_MS),
  info: (message: string) => useToasts.getState().push('info', message),
};
