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
import { describe, expect, it } from 'vitest';
import { statesFromLogs } from '../builder/run-paint.js';
import type { RunLog } from '../api.js';

const completed = (nodeId: string, extra: Partial<RunLog> = {}): RunLog => ({
  nodeId,
  event: 'workflow.node.completed',
  outcome: 'completed',
  ...extra,
});

describe('statesFromLogs: the degraded set carries its reason', () => {
  it('a degraded step hands the run reason on to the chip and the banner', () => {
    const why = 'the cloud can open that reference but cannot filter it';
    const { states, degraded } = statesFromLogs([
      completed('a'),
      completed('b', { binding: 'local-degraded', degradedReason: why }),
    ]);
    expect(degraded).toEqual({ b: { why } });
    // Degraded is a modifier, never an outcome: the step still reads completed.
    expect(states.b).toBe('completed');
  });

  it('a degraded step from before the reason was carried still reads degraded', () => {
    // The fallback path. An empty-string value here would silently un-mark the
    // step, which is why the entry is an object and not the reason itself.
    const { degraded } = statesFromLogs([completed('b', { binding: 'local-degraded' })]);
    expect(degraded.b).toEqual({ why: undefined });
    expect(Boolean(degraded.b)).toBe(true);
  });

  it('a run that never degraded marks nothing', () => {
    const { degraded } = statesFromLogs([completed('a', { binding: 'local' }), completed('b', { binding: 'cloud' })]);
    expect(degraded).toEqual({});
  });
});
