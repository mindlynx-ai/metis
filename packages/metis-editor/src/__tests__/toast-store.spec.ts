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
 * The toast store: transient feedback for saves, runs and removals. Toasts
 * auto-dismiss (errors linger longer), can be dismissed by hand, and the
 * queue stays bounded so a burst never floods the screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useToasts, toast } from '../toast-store.js';

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes a toast with its variant and message', () => {
    toast.success('Workflow saved');
    const items = useToasts.getState().toasts;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ variant: 'success', message: 'Workflow saved' });
  });

  it('auto-dismisses after the default duration', () => {
    toast.info('Run started');
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('errors linger longer than the default', () => {
    toast.error('Could not save');
    vi.advanceTimersByTime(4000);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('dismiss(id) removes a toast by hand', () => {
    const id = toast.success('bye');
    useToasts.getState().dismiss(id);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('caps the queue by dropping the oldest', () => {
    for (let i = 1; i <= 6; i += 1) toast.info(`t${i}`);
    const messages = useToasts.getState().toasts.map((t) => t.message);
    expect(messages).toEqual(['t3', 't4', 't5', 't6']);
  });
});
