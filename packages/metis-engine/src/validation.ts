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
 * Definition validation. Largely new code: the live engine
 * tolerates multiple start nodes silently and delegates graph checks to
 * helix-core. Metis enforces structural rules at start time and the
 * stricter trigger-entry rule at publish time.
 */
import type { WorkflowDefinition } from './types.js';
import { loopBodyIds } from './workflows/graph.js';

/** Config-only node types: present in definitions, never executed. */
export const CONFIG_ONLY_NODE_TYPES = new Set([
  'apiconfig',
  'apiend',
  'webhookconfig',
  'scheduleconfig',
]);

const WORKFLOW_TRIGGER_TYPES = new Set(['signal', 'webhookconfig', 'scheduleconfig']);

export interface ValidationOptions {
  kind: 'workflow' | 'api';
  level: 'start' | 'publish';
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function structuralErrors(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const ids = definition.nodes.map((node) => node.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    errors.push(`duplicate node ids: ${[...new Set(duplicates)].join(', ')}`);
  }
  for (const edge of definition.edges) {
    for (const endpoint of [edge.source, edge.target]) {
      if (!idSet.has(endpoint)) {
        errors.push(`edge references a missing node "${endpoint}"`);
      }
    }
  }
  return errors;
}

const typeOf = (node: { type: string }) => node.type.toLowerCase();

/**
 * Cycle detection (Kahn's algorithm). The engine is a one-shot DAG walker: a
 * back-edge does not loop, it silently strands the cyclic region as Pending
 * while the run reports completed - so cycles must fail loudly at start time.
 */
function cycleErrors(definition: WorkflowDefinition): string[] {
  const inDegree = new Map<string, number>(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) {
    if (inDegree.has(edge.target)) inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...inDegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of definition.edges) {
      if (edge.source !== current || !inDegree.has(edge.target)) continue;
      const next = (inDegree.get(edge.target) ?? 1) - 1;
      inDegree.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }
  const cyclic = definition.nodes.map((node) => node.id).filter((id) => !seen.has(id));
  if (cyclic.length === 0) return [];
  return [
    `the graph has a cycle involving: ${cyclic.join(', ')} (to iterate, use the Loop node's 'each' output, not a back-edge)`,
  ];
}

/** All nodes reachable by following edges forward from startIds. */
function reachableFrom(startIds: string[], definition: WorkflowDefinition): Set<string> {
  const visited = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of definition.edges) {
      if (edge.source === current) queue.push(edge.target);
    }
  }
  return visited;
}

/** One loop node's structural rules: the body must be a clean child graph. */
function singleLoopErrors(
  loop: { id: string },
  definition: WorkflowDefinition,
  typeById: Map<string, string>,
): string[] {
  const errors: string[] = [];
  const eachEdges = definition.edges.filter(
    (edge) => edge.source === loop.id && edge.sourceHandle === 'each',
  );
  if (eachEdges.length !== 1) {
    return [`loop "${loop.id}" must have exactly one 'each' edge (found ${eachEdges.length})`];
  }
  const body = new Set(loopBodyIds(loop.id, definition.edges));
  // The body runs as a child workflow: nothing outside it may depend on or
  // feed into it directly.
  const doneReachable = reachableFrom(
    definition.edges
      .filter((edge) => edge.source === loop.id && edge.sourceHandle === 'done')
      .map((edge) => edge.target),
    definition,
  );
  for (const id of body) {
    if (doneReachable.has(id)) {
      errors.push(`node "${id}" is reachable from both the loop's 'each' and 'done' outputs`);
    }
    if (typeById.get(id) === 'loop') {
      errors.push(`nested loop "${id}" inside the body of "${loop.id}" is not supported`);
    }
  }
  for (const edge of definition.edges) {
    if (body.has(edge.target) && edge.source !== loop.id && !body.has(edge.source)) {
      errors.push(`edge from "${edge.source}" enters the loop body at "${edge.target}"`);
    }
  }
  return errors;
}

/** Loop-node structural rules (v1) across the whole graph. */
function loopErrors(definition: WorkflowDefinition): string[] {
  const typeById = new Map(definition.nodes.map((node) => [node.id, typeOf(node)]));
  return definition.nodes
    .filter((node) => typeOf(node) === 'loop')
    .flatMap((loop) => singleLoopErrors(loop, definition, typeById));
}

function startNodeErrors(definition: WorkflowDefinition): { starts: WorkflowDefinition['nodes']; errors: string[] } {
  const errors: string[] = [];
  const targets = new Set(definition.edges.map((edge) => edge.target));
  const starts = definition.nodes.filter((node) => !targets.has(node.id));
  if (starts.length === 0) {
    errors.push('the graph has no start node: every node has an incoming edge');
  } else if (starts.length > 1) {
    errors.push(
      `the graph must have exactly one start node; found ${starts.length} (${starts
        .map((node) => node.id)
        .join(', ')})`,
    );
  }
  return { starts, errors };
}

function apiKindErrors(definition: WorkflowDefinition, starts: WorkflowDefinition['nodes']): string[] {
  const errors: string[] = [];
  if (starts.length === 1 && starts[0] && typeOf(starts[0]) !== 'apiconfig') {
    errors.push('an api graph must start at an apiconfig node');
  }
  const apiEnds = definition.nodes.filter((node) => typeOf(node) === 'apiend');
  if (apiEnds.length !== 1) {
    errors.push(`an api graph must contain exactly one apiend node; found ${apiEnds.length}`);
  }
  if (definition.nodes.some((node) => typeOf(node) === 'loop')) {
    errors.push('an api graph cannot contain a loop node (loops run child workflows; api runs are synchronous)');
  }
  return errors;
}

function workflowKindErrors(
  definition: WorkflowDefinition,
  starts: WorkflowDefinition['nodes'],
  level: ValidationOptions['level'],
): string[] {
  const errors: string[] = [];
  if (definition.nodes.some((node) => typeOf(node) === 'apiconfig' || typeOf(node) === 'apiend')) {
    errors.push('a workflow graph must not contain api nodes (apiconfig or apiend)');
  }
  const start = starts.length === 1 ? starts[0] : undefined;
  if (level === 'publish' && start && !WORKFLOW_TRIGGER_TYPES.has(typeOf(start))) {
    errors.push(
      'a published workflow must start with a trigger node (signal, webhookconfig or scheduleconfig)',
    );
  }
  return errors;
}

export function validateDefinition(
  definition: WorkflowDefinition,
  options: ValidationOptions,
): ValidationResult {
  const errors: string[] = [];
  if (definition.nodes.length === 0) {
    errors.push('the definition has no nodes');
    return { valid: false, errors };
  }
  errors.push(...structuralErrors(definition));
  errors.push(...cycleErrors(definition));
  errors.push(...loopErrors(definition));
  const { starts, errors: startErrors } = startNodeErrors(definition);
  errors.push(...startErrors);
  errors.push(
    ...(options.kind === 'api'
      ? apiKindErrors(definition, starts)
      : workflowKindErrors(definition, starts, options.level)),
  );
  return { valid: errors.length === 0, errors };
}
