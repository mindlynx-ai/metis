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
 * The canvas branch handles MUST use the ids the engine routes by, or an edge a
 * user draws from a branch points at a target that never fires: a switch routes
 * by source-<optionId> / source-default (nodes/switch.ts partitionTargets), a
 * logic node by true / false (create-activities logic branch).
 */
import { describe, it, expect } from 'vitest';
import { outputPorts } from '../builder/node-visual.js';

describe('outputPorts (branch handles match the engine routing)', () => {
  it('a switch has one handle per configured branch, plus the fall-through', () => {
    const ports = outputPorts('switch', {
      switchOptions: [
        { id: 'big', name: 'Big order' },
        { id: 'vip', name: 'VIP' },
      ],
    });
    expect(ports.map((port) => port.id)).toEqual(['source-big', 'source-vip', 'source-default']);
    expect(ports.map((port) => port.label)).toEqual(['Big order', 'VIP', 'Otherwise']);
  });

  it('a switch with no options still offers the default branch', () => {
    const ports = outputPorts('switch', {});
    expect(ports).toEqual([{ id: 'source-default', label: 'Otherwise', top: '50%' }]);
  });

  it('a logic node routes true / false (not source-*)', () => {
    expect(outputPorts('logic').map((port) => port.id)).toEqual(['true', 'false']);
  });

  it('every other node has a single unnamed output (sourceHandle null connects it)', () => {
    const ports = outputPorts('data');
    expect(ports).toHaveLength(1);
    expect(ports[0]?.id).toBeUndefined();
  });

  it('stop and error is terminal: no output handle at all', () => {
    expect(outputPorts('stopanderror')).toEqual([]);
  });

  it('a loop offers each/done handles (the ids the engine routes by)', () => {
    expect(outputPorts('loop').map((port) => port.id)).toEqual(['each', 'done']);
    expect(outputPorts('loop').map((port) => port.label)).toEqual(['Each item', 'Done']);
  });
});
