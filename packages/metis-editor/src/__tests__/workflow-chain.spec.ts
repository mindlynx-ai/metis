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
import { chainPreview } from '../workflow-chain.js';
import type { WorkflowEdge, WorkflowNode } from '../api.js';

const node = (id: string, type: string): WorkflowNode => ({ id, type, version: 'v1', data: { label: type, config: {} } });
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}-${target}`, source, target, sourceHandle: null });

describe('chainPreview', () => {
  it('orders a linear flow from its start node', () => {
    const nodes = [node('c', 'code'), node('a', 'webhookconfig'), node('b', 'api')];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const { shown, overflow } = chainPreview(nodes, edges, 5);
    expect(shown.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(overflow).toBe(0);
  });

  it('truncates to max and reports the overflow count', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => node(id, 'code'));
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e'), edge('e', 'f'), edge('f', 'g')];
    const { shown, overflow } = chainPreview(nodes, edges, 5);
    expect(shown.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(overflow).toBe(2);
  });

  it('places roots first then follows edges across a branch', () => {
    // a -> b, a -> c: a is the root, then its children in edge order.
    const nodes = [node('b', 'api'), node('c', 'api'), node('a', 'webhookconfig')];
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const { shown } = chainPreview(nodes, edges, 5);
    expect(shown[0]!.id).toBe('a');
    expect(shown.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('still lists disconnected nodes (after the connected chain)', () => {
    const nodes = [node('a', 'webhookconfig'), node('b', 'api'), node('lonely', 'code')];
    const { shown } = chainPreview(nodes, [edge('a', 'b')], 5);
    expect(shown.map((n) => n.id)).toContain('lonely');
    expect(shown).toHaveLength(3);
  });

  it('handles an empty graph', () => {
    expect(chainPreview([], [], 5)).toEqual({ shown: [], overflow: 0 });
  });

  it('terminates on a cycle', () => {
    const nodes = [node('a', 'code'), node('b', 'code')];
    const { shown } = chainPreview(nodes, [edge('a', 'b'), edge('b', 'a')], 5);
    expect(shown.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });
});
