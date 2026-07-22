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
import { describe, it, expect } from 'vitest';
import { deriveWhereabouts, labelMapOf } from '../whereabouts.js';

const labels = new Map([
  ['n1', 'Fetch orders'],
  ['n2', 'Approve'],
]);
const labelOf = (id: string) => labels.get(id);

describe('deriveWhereabouts (where a running execution genuinely is)', () => {
  it('a parked signal node wins: waiting + the signal it waits for', () => {
    const logs = [
      { nodeId: 'n1', event: 'workflow.node.started' },
      { nodeId: 'n1', event: 'workflow.node.completed' },
      { nodeId: 'n2', event: 'workflow.node.waiting', signalType: 'approve-order' },
    ];
    expect(deriveWhereabouts(logs, labelOf)).toEqual({
      runState: 'waiting',
      waitingOn: { signalType: 'approve-order', until: undefined },
    });
  });

  it('a waituntil park reports the wake time', () => {
    const logs = [{ nodeId: 'n1', event: 'workflow.node.waiting', until: '2026-07-10T14:32:00.000Z' }];
    expect(deriveWhereabouts(logs, labelOf).waitingOn).toEqual({
      signalType: undefined,
      until: '2026-07-10T14:32:00.000Z',
    });
  });

  it('a RESUMED park no longer counts: the run is at its current step', () => {
    const logs = [
      { nodeId: 'n1', event: 'workflow.node.waiting', signalType: 'go' },
      { nodeId: 'n1', event: 'workflow.node.completed' },
      { nodeId: 'n2', event: 'workflow.node.started' },
    ];
    expect(deriveWhereabouts(logs, labelOf)).toEqual({ runState: 'running', atNode: 'Approve' });
  });

  it('an unlabelled current step falls back to the node type', () => {
    const logs = [{ nodeId: 'nx', nodeType: 'code', event: 'workflow.node.started' }];
    expect(deriveWhereabouts(logs, labelOf).atNode).toBe('code');
  });
});

describe('labelMapOf', () => {
  it('reads labels from wire-shaped (data.label) and flat nodes', () => {
    const map = labelMapOf({
      nodes: [
        { id: 'a', data: { label: 'Start' } },
        { id: 'b', label: 'Flat' },
        { id: 'c' },
      ],
    });
    expect(map.get('a')).toBe('Start');
    expect(map.get('b')).toBe('Flat');
    expect(map.has('c')).toBe(false);
  });
});
