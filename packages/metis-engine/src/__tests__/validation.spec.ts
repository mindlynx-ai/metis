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
import { validateDefinition } from '../validation.js';
import type { WorkflowDefinition } from '../types.js';

const node = (id: string, type = 'echo') => ({ id, type });

describe('definition validation', () => {
  it('accepts a simple single-start workflow graph', () => {
    const definition: WorkflowDefinition = {
      nodes: [node('a'), node('b')],
      edges: [{ source: 'a', target: 'b' }],
    };
    expect(validateDefinition(definition, { kind: 'workflow', level: 'start' })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects an empty graph', () => {
    const result = validateDefinition({ nodes: [], edges: [] }, { kind: 'workflow', level: 'start' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/no nodes/i);
  });

  it('rejects a graph with no start node', () => {
    const definition: WorkflowDefinition = {
      nodes: [node('a'), node('b')],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    };
    const result = validateDefinition(definition, { kind: 'workflow', level: 'start' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/start node/i);
  });

  it('rejects a graph with more than one start node', () => {
    const definition: WorkflowDefinition = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [{ source: 'a', target: 'c' }],
    };
    const result = validateDefinition(definition, { kind: 'workflow', level: 'start' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/exactly one start node/i);
  });

  it('rejects duplicate node ids and dangling edges', () => {
    const definition: WorkflowDefinition = {
      nodes: [node('a'), node('a'), node('b')],
      edges: [{ source: 'a', target: 'ghost' }],
    };
    const result = validateDefinition(definition, { kind: 'workflow', level: 'start' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/duplicate/i);
    expect(result.errors.join(' ')).toMatch(/ghost/);
  });

  it('api graphs must start at apiconfig and contain exactly one apiend', () => {
    const missingConfig: WorkflowDefinition = {
      nodes: [node('work'), node('end', 'apiend')],
      edges: [{ source: 'work', target: 'end' }],
    };
    expect(validateDefinition(missingConfig, { kind: 'api', level: 'start' }).errors.join(' ')).toMatch(
      /apiconfig/i,
    );

    const twoEnds: WorkflowDefinition = {
      nodes: [node('cfg', 'apiconfig'), node('w'), node('e1', 'apiend'), node('e2', 'apiend')],
      edges: [
        { source: 'cfg', target: 'w' },
        { source: 'w', target: 'e1' },
        { source: 'w', target: 'e2' },
      ],
    };
    expect(validateDefinition(twoEnds, { kind: 'api', level: 'start' }).errors.join(' ')).toMatch(
      /exactly one apiend/i,
    );
  });

  it('workflow graphs must not contain api nodes', () => {
    const definition: WorkflowDefinition = {
      nodes: [node('cfg', 'apiconfig'), node('b')],
      edges: [{ source: 'cfg', target: 'b' }],
    };
    const result = validateDefinition(definition, { kind: 'workflow', level: 'start' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/api/i);
  });

  it('publish level requires a trigger entry for workflow graphs', () => {
    const bare: WorkflowDefinition = {
      nodes: [node('a'), node('b')],
      edges: [{ source: 'a', target: 'b' }],
    };
    expect(validateDefinition(bare, { kind: 'workflow', level: 'start' }).valid).toBe(true);
    const published = validateDefinition(bare, { kind: 'workflow', level: 'publish' });
    expect(published.valid).toBe(false);
    expect(published.errors.join(' ')).toMatch(/trigger/i);

    const triggered: WorkflowDefinition = {
      nodes: [node('t', 'signal'), node('b')],
      edges: [{ source: 't', target: 'b' }],
    };
    expect(validateDefinition(triggered, { kind: 'workflow', level: 'publish' }).valid).toBe(true);
  });

  it('rejects a cyclic graph, naming the cycle and pointing at the loop node', () => {
    // a -> b -> c -> b: the engine is a one-shot DAG walker; a back-edge would
    // silently stall, so it must fail loudly at start time instead.
    const definition: WorkflowDefinition = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'b' },
      ],
    };
    const result = validateDefinition(definition, { kind: 'workflow', level: 'start' });
    expect(result.valid).toBe(false);
    const text = result.errors.join(' ');
    expect(text).toMatch(/cycle/i);
    expect(text).toContain('b');
    expect(text).toMatch(/each/i); // the "loops use the 'each' output" hint
  });
});

describe('loop node validation', () => {
  const loopDef = (edges: WorkflowDefinition['edges'], extra: WorkflowDefinition['nodes'] = []) => ({
    nodes: [node('start'), node('loop', 'loop'), node('body'), node('after'), ...extra],
    edges,
  });
  const validate = (definition: WorkflowDefinition) =>
    validateDefinition(definition, { kind: 'workflow', level: 'start' });

  const goodEdges = [
    { source: 'start', target: 'loop' },
    { source: 'loop', target: 'body', sourceHandle: 'each' },
    { source: 'loop', target: 'after', sourceHandle: 'done' },
  ];

  it('accepts a well-formed loop (one each edge, disjoint body/done)', () => {
    expect(validate(loopDef(goodEdges))).toEqual({ valid: true, errors: [] });
  });

  it('requires exactly one each edge', () => {
    const none = validate(loopDef([goodEdges[0]!, goodEdges[2]!]));
    expect(none.valid).toBe(false);
    expect(none.errors.join(' ')).toMatch(/each/);
    const two = validate(
      loopDef([...goodEdges, { source: 'loop', target: 'after', sourceHandle: 'each' }]),
    );
    expect(two.valid).toBe(false);
  });

  it('rejects a node reachable from both each and done', () => {
    const shared = validate(
      loopDef([...goodEdges, { source: 'body', target: 'after' }]),
    );
    expect(shared.valid).toBe(false);
    expect(shared.errors.join(' ')).toMatch(/both/i);
  });

  it('rejects an external edge into the loop body', () => {
    const intruded = validate(
      loopDef([...goodEdges, { source: 'start', target: 'body' }]),
    );
    expect(intruded.valid).toBe(false);
    expect(intruded.errors.join(' ')).toMatch(/body/i);
  });

  it('rejects a nested loop inside a body (v1)', () => {
    const nested = validate(
      loopDef(
        [...goodEdges, { source: 'body', target: 'inner' }],
        [node('inner', 'loop')],
      ),
    );
    expect(nested.valid).toBe(false);
    expect(nested.errors.join(' ')).toMatch(/nested/i);
  });

  it('rejects a loop in an api graph', () => {
    const definition: WorkflowDefinition = {
      nodes: [node('a', 'apiconfig'), node('loop', 'loop'), node('body'), node('end', 'apiend')],
      edges: [
        { source: 'a', target: 'loop' },
        { source: 'loop', target: 'body', sourceHandle: 'each' },
        { source: 'loop', target: 'end', sourceHandle: 'done' },
      ],
    };
    const result = validateDefinition(definition, { kind: 'api', level: 'start' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/api/i);
  });
});
