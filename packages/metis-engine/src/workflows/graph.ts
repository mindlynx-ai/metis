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
 * Pure graph-walk helpers shared by the workflow runners.
 * Deterministic and dependency-free: safe inside workflow code.
 */
import type { RuntimeNode, WorkflowEdge } from '../types.js';

export function sourcesOf(
  node: RuntimeNode,
  nodes: RuntimeNode[],
  edges: WorkflowEdge[],
): RuntimeNode[] {
  const sourceIds = edges.filter((edge) => edge.target === node.id).map((edge) => edge.source);
  return nodes.filter((candidate) => sourceIds.includes(candidate.id));
}

export function isDone(node: RuntimeNode): boolean {
  return (
    node.nodeStatus === 'Complete' ||
    node.nodeStatus === 'Orphaned' ||
    // Failed-but-continue (policy onFailure): terminal, non-fatal; readiness
    // and orphan cascades treat it like any other finished source.
    node.nodeStatus === 'Failed'
  );
}

export function getAvailableNodes(nodes: RuntimeNode[], edges: WorkflowEdge[]): RuntimeNode[] {
  return nodes.filter(
    (node) =>
      node.nodeStatus === 'Pending' &&
      sourcesOf(node, nodes, edges).every((source) => isDone(source)),
  );
}

/**
 * The ids of a loop node's BODY: everything BFS-reachable from its `each`
 * handle. Pure and edge-shape only, so validation and the workflow share it.
 */
export function loopBodyIds(loopNodeId: string, edges: WorkflowEdge[]): string[] {
  const body: string[] = [];
  const queue = edges
    .filter((edge) => edge.source === loopNodeId && edge.sourceHandle === 'each')
    .map((edge) => edge.target);
  const visited = new Set<string>([loopNodeId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    body.push(current);
    for (const edge of edges) {
      if (edge.source === current) queue.push(edge.target);
    }
  }
  return body;
}

/**
 * Cascade-orphan all reachable descendants of startId. A descendant is
 * orphaned only if ALL its sources are Complete or Orphaned after the
 * cascade, so convergence points with a live upstream path survive.
 * Iterative BFS, as in the origin, to avoid recursion depth limits.
 */
export function cascadeOrphan(
  startId: string,
  nodes: RuntimeNode[],
  edges: WorkflowEdge[],
): string[] {
  const orphaned: string[] = [];
  const queue: string[] = [startId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const successorIds = edges.filter((edge) => edge.source === current).map((edge) => edge.target);
    for (const successorId of successorIds) {
      const successor = nodes.find((candidate) => candidate.id === successorId);
      if (!successor || successor.nodeStatus !== 'Pending') continue;
      const allDead = sourcesOf(successor, nodes, edges).every((source) => isDone(source));
      if (allDead) {
        successor.nodeStatus = 'Orphaned';
        orphaned.push(successorId);
        queue.push(successorId);
      }
    }
  }
  return orphaned;
}
