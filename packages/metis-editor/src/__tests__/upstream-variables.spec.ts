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
import { collectUpstreamVariables } from '../builder/inspector/upstream-variables.js';
import type { CatalogueEntry, WorkflowEdge, WorkflowNode } from '../api.js';

const node = (id: string, type: string, data: Partial<WorkflowNode['data']> = {}): WorkflowNode => ({
  id,
  type,
  version: 'v1',
  data: { label: data.label ?? type, config: {}, ...data },
});
const edge = (source: string, target: string): WorkflowEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle: null,
});

const catalogue: CatalogueEntry[] = [
  { type: 'webhookconfig', category: 'trigger', outputSchema: { type: 'object' } },
  { type: 'code', category: 'transform', outputSchema: { type: 'object', properties: { result: { type: 'object' } } } },
  { type: 'api', category: 'integration', outputSchema: { type: 'object', properties: { status: { type: 'number' }, body: { type: 'object' } } } },
  { type: 'http', category: 'integration', alias_of: 'api' },
] as CatalogueEntry[];

describe('collectUpstreamVariables', () => {
  it('offers declared instance outputs ahead of the catalogue schema', () => {
    const nodes = [
      node('hook', 'webhookconfig', {
        label: 'Webhook',
        outputs: [{ manualData: [{ key: 'body.firstName', type: 'string' }, { key: 'body.email', type: 'string' }] }],
      }),
      node('step', 'code'),
    ];
    const sources = collectUpstreamVariables({ nodeId: 'step', nodes, edges: [edge('hook', 'step')], catalogue });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.variables.map((v) => v.reference)).toEqual([
      '{{hook.data.body.firstName}}',
      '{{hook.data.body.email}}',
    ]);
  });

  it('falls back to the catalogue outputSchema when no outputs are declared', () => {
    const nodes = [node('a', 'api'), node('b', 'code')];
    const sources = collectUpstreamVariables({ nodeId: 'b', nodes, edges: [edge('a', 'b')], catalogue });
    expect(sources[0]!.variables.map((v) => v.key)).toEqual(['status', 'body']);
    expect(sources[0]!.variables[0]!.reference).toBe('{{a.data.status}}');
  });

  it('resolves an alias node type to its target schema', () => {
    const nodes = [node('a', 'http'), node('b', 'code')];
    const sources = collectUpstreamVariables({ nodeId: 'b', nodes, edges: [edge('a', 'b')], catalogue });
    expect(sources[0]!.variables.map((v) => v.key)).toEqual(['status', 'body']);
  });

  it('offers a generic data chip when a node has neither outputs nor a schema', () => {
    const nodes = [node('hook', 'webhookconfig'), node('step', 'code')];
    const sources = collectUpstreamVariables({ nodeId: 'step', nodes, edges: [edge('hook', 'step')], catalogue });
    expect(sources[0]!.variables).toEqual([{ key: 'data', reference: '{{hook.data}}' }]);
  });

  it('walks all ancestors closest-first, not just direct parents', () => {
    const nodes = [node('t', 'webhookconfig', { label: 'Trigger' }), node('m', 'api', { label: 'Mid' }), node('end', 'code')];
    const edges = [edge('t', 'm'), edge('m', 'end')];
    const sources = collectUpstreamVariables({ nodeId: 'end', nodes, edges, catalogue });
    expect(sources.map((s) => s.nodeId)).toEqual(['m', 't']);
    expect(sources.map((s) => s.distance)).toEqual([1, 2]);
  });

  it('scopes to ancestors only: a sibling branch offers nothing', () => {
    // t -> a ; t -> b. Configuring b must not see a (not an ancestor of b).
    const nodes = [node('t', 'webhookconfig'), node('a', 'code', { label: 'A' }), node('b', 'code', { label: 'B' })];
    const edges = [edge('t', 'a'), edge('t', 'b')];
    const sources = collectUpstreamVariables({ nodeId: 'b', nodes, edges, catalogue });
    expect(sources.map((s) => s.nodeId)).toEqual(['t']);
  });

  it('lists a diamond-reachable ancestor once at its shortest distance', () => {
    // t -> l -> j ; t -> r -> j. t is reachable via two 2-hop paths.
    const nodes = ['t', 'l', 'r', 'j'].map((id) => node(id, 'code'));
    const edges = [edge('t', 'l'), edge('t', 'r'), edge('l', 'j'), edge('r', 'j')];
    const sources = collectUpstreamVariables({ nodeId: 'j', nodes, edges, catalogue });
    const t = sources.find((s) => s.nodeId === 't');
    expect(sources.filter((s) => s.nodeId === 't')).toHaveLength(1);
    expect(t!.distance).toBe(2);
  });

  it('terminates on a cycle without spinning, never offering the node itself', () => {
    const nodes = [node('x', 'code'), node('y', 'code')];
    const edges = [edge('x', 'y'), edge('y', 'x')];
    const sources = collectUpstreamVariables({ nodeId: 'x', nodes, edges, catalogue });
    expect(sources.map((s) => s.nodeId)).toEqual(['y']);
  });
});
