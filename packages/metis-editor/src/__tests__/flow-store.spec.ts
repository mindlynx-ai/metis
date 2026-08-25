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
 * The store's edit model is the correctness fix: per-field merges must
 * never drop keys the config schema does not name (the old whole-config
 * replace did). These checks pin that, plus default seeding and the
 * schema-helper round-trip.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useFlow } from '../flow-store.js';
import { defaultsFor, fromDraftValue, toDraftValue, widgetFor } from '../builder/inspector/schema.js';

const reset = () =>
  useFlow.setState({ nodes: [], edges: [], selectedNodeId: undefined, dirty: false, exists: false });

describe('flow-store edit model', () => {
  beforeEach(reset);

  it('reset() clears a loaded workflow to a fresh, empty, unsaved one', () => {
    // Simulate having a saved workflow open with a step.
    useFlow.setState({ workflowId: 'wf_old', name: 'Old flow', status: 'published', exists: true });
    useFlow.getState().addNode({ type: 'api', label: 'Call' });
    expect(useFlow.getState().nodes).toHaveLength(1);

    useFlow.getState().reset();

    const state = useFlow.getState();
    expect(state.workflowId).toBeUndefined();
    expect(state.name).toBe('Untitled workflow');
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.status).toBe('draft');
    expect(state.exists).toBe(false);
    expect(state.dirty).toBe(false);
  });

  it('seeds defaults at creation and merges one field without dropping others', () => {
    const store = useFlow.getState();
    store.addNode({ type: 'api', label: 'Call', config: { method: 'GET', timeout: 30 } });
    const id = useFlow.getState().nodes[0]!.id;

    // A field the schema does not name, written directly (e.g. an imported key).
    useFlow.getState().updateConfigField(id, 'legacyHeader', 'x-trace');
    useFlow.getState().updateConfigField(id, 'method', 'POST');

    const config = useFlow.getState().nodes[0]!.data.config;
    expect(config).toEqual({ method: 'POST', timeout: 30, legacyHeader: 'x-trace' });
  });

  it('clears a key when the field is emptied to undefined', () => {
    const store = useFlow.getState();
    store.addNode({ type: 'api', label: 'Call', config: { url: 'https://x', timeout: 30 } });
    const id = useFlow.getState().nodes[0]!.id;

    useFlow.getState().updateConfigField(id, 'timeout', undefined);
    expect(useFlow.getState().nodes[0]!.data.config).toEqual({ url: 'https://x' });
  });

  it('merges policy without clobbering unset policy fields', () => {
    const store = useFlow.getState();
    store.addNode({ type: 'api', label: 'Call' });
    const id = useFlow.getState().nodes[0]!.id;

    useFlow.getState().updatePolicy(id, { retries: 3 });
    useFlow.getState().updatePolicy(id, { onFailure: 'continue' });
    expect(useFlow.getState().nodes[0]!.data.policy).toEqual({ retries: 3, onFailure: 'continue' });
  });
});

describe('inspector schema helpers', () => {
  it('collects property defaults', () => {
    const schema = {
      properties: { method: { type: 'string', default: 'GET' }, url: { type: 'string' } },
    };
    expect(defaultsFor(schema)).toEqual({ method: 'GET' });
  });

  it('picks widgets from hints, format, and type', () => {
    expect(widgetFor('method', { 'x-helix-widget': 'method' })).toBe('method');
    expect(widgetFor('method', { type: 'string', enum: ['GET', 'POST'] })).toBe('method');
    expect(widgetFor('conn', { 'x-helix-widget': 'connectorRef' })).toBe('connector');
    expect(widgetFor('endpoint', { format: 'uri' })).toBe('uri');
    expect(widgetFor('enabled', { type: 'boolean' })).toBe('checkbox');
    expect(widgetFor('count', { type: 'integer' })).toBe('number');
    expect(widgetFor('headers', { type: 'object' })).toBe('headers');
    expect(widgetFor('name', { type: 'string' })).toBe('text');
  });

  it('routes the body envelope to the body widget, plain objects to json', () => {
    const envelope = {
      type: 'object',
      properties: { type: { type: 'string', enum: ['json', 'none'] }, content: {} },
    };
    expect(widgetFor('body', envelope)).toBe('body');
    expect(widgetFor('auth', { type: 'object' })).toBe('json');
  });

  it('round-trips values through draft strings', () => {
    expect(fromDraftValue(toDraftValue(42, 'number'), 'number')).toEqual({ value: 42 });
    expect(fromDraftValue(toDraftValue(true, 'checkbox'), 'checkbox')).toEqual({ value: true });
    const obj = { a: 1 };
    expect(fromDraftValue(toDraftValue(obj, 'json'), 'json')).toEqual({ value: obj });
    expect(fromDraftValue('{bad', 'json').error).toBeTruthy();
  });
});

/**
 * Removing an edge. There was no way to do this at all: `connect` had no
 * opposite, and the only code that ever dropped an edge was `removeNode`, as a
 * side effect of deleting one of its ends. A tester reported it as "I am unable
 * to delink them" and was right - the answer was to delete a node and rebuild it.
 */
describe('removing an edge', () => {
  // Its own reset: the one above is scoped to the other describe block, so
  // without this the store carries nodes in from earlier tests.
  beforeEach(reset);

  const twoConnectedNodes = () => {
    const store = useFlow.getState();
    store.addNode({ type: 'api', label: 'First' });
    store.addNode({ type: 'api', label: 'Second' });
    const [first, second] = useFlow.getState().nodes;
    useFlow.getState().connect({ source: first!.id, target: second!.id });
    return { first: first!.id, second: second!.id };
  };

  it('drops the edge and leaves both nodes standing', () => {
    twoConnectedNodes();
    const edge = useFlow.getState().edges[0]!;
    useFlow.setState({ dirty: false });

    useFlow.getState().removeEdge(edge.id);

    expect(useFlow.getState().edges).toHaveLength(0);
    // The whole point: unlike removeNode, the steps survive.
    expect(useFlow.getState().nodes).toHaveLength(2);
    expect(useFlow.getState().dirty).toBe(true);
  });

  it('leaves other edges alone', () => {
    const { first, second } = twoConnectedNodes();
    useFlow.getState().addNode({ type: 'api', label: 'Third' });
    const third = useFlow.getState().nodes[2]!.id;
    useFlow.getState().connect({ source: second, target: third });
    expect(useFlow.getState().edges).toHaveLength(2);

    const firstEdge = useFlow.getState().edges.find((e) => e.source === first)!;
    useFlow.getState().removeEdge(firstEdge.id);

    const left = useFlow.getState().edges;
    expect(left).toHaveLength(1);
    expect(left[0]!.source).toBe(second);
  });

  it('ignores an id that is not there rather than throwing', () => {
    twoConnectedNodes();
    useFlow.setState({ dirty: false });

    useFlow.getState().removeEdge('edge-that-never-existed');

    expect(useFlow.getState().edges).toHaveLength(1);
    // Nothing changed, so nothing to save. Marking the graph dirty here would
    // offer a Save for an edit that did not happen.
    expect(useFlow.getState().dirty).toBe(false);
  });

  it('lets the same two nodes be reconnected afterwards', () => {
    const { first, second } = twoConnectedNodes();
    useFlow.getState().removeEdge(useFlow.getState().edges[0]!.id);
    // connect() refuses a duplicate, so a stale edge left behind would make
    // relinking silently impossible.
    useFlow.getState().connect({ source: first, target: second });
    expect(useFlow.getState().edges).toHaveLength(1);
  });
});
