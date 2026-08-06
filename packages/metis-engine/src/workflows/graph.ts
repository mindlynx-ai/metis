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
import type { RuntimeNode, SwitchNodeOutput, WorkflowEdge } from '../types.js';

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
    // treats it like any other finished source.
    node.nodeStatus === 'Failed'
  );
}

/**
 * Whether a source offers NO live path onwards - which only an orphaned one
 * does. Readiness asks whether a source has finished (isDone); the orphan
 * cascade asks the opposite question and must not borrow that answer: a
 * Complete source has already run and handed its output down, and a
 * Failed-but-continue one carried the walk on past it. Counting either as
 * dead orphaned a join whose successful parent happened to finish first,
 * making the same graph run or not run on timing alone.
 */
export function isDeadSource(node: RuntimeNode): boolean {
  return node.nodeStatus === 'Orphaned';
}

/**
 * Which node an inbound signal belongs to. A signal node answers to its
 * configured name; any other node answers only while a park its handler
 * asked for is open, so a stray signal cannot resume a node that is not
 * waiting for one.
 */
export function signalTarget(nodes: RuntimeNode[], wanted: string): RuntimeNode | undefined {
  return nodes.find((candidate) => {
    if (candidate.signalReceived === true) return false;
    if (candidate.nodeStatus !== 'Pending' && candidate.nodeStatus !== 'InProgress') return false;
    const listening =
      candidate.type.toLowerCase() === 'signal'
        ? String(candidate.config?.signalType ?? '')
        : (candidate.awaitingSignalType ?? '');
    return listening !== '' && listening.toLowerCase() === wanted;
  });
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
 * orphaned only if EVERY one of its sources is itself Orphaned, so a
 * convergence point keeps its live upstream path whether that path has
 * already run or has not started yet.
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
      const allDead = sourcesOf(successor, nodes, edges).every((source) => isDeadSource(source));
      if (allDead) {
        successor.nodeStatus = 'Orphaned';
        orphaned.push(successorId);
        queue.push(successorId);
      }
    }
  }
  return orphaned;
}

/**
 * Orphan the losing direct targets of a branch node (unless another live path
 * feeds them), then cascade from each so the selected branch is never swept up
 * (origin behaviour: the cascade starts below the orphaned children, not at
 * the branch node itself).
 *
 * The branch node ran and did NOT take these edges, so for these targets it is
 * the one dead source however Complete it reads; every other source has to be
 * dead in its own right before a target loses its last live path.
 */
export function applySwitchPartition(
  branchNodeId: string,
  partition: SwitchNodeOutput,
  nodes: RuntimeNode[],
  edges: WorkflowEdge[],
): string[] {
  const orphanedNow: string[] = [];
  const orphanedIds = partition.orphanedTargetIds ?? [];
  const dead = (source: RuntimeNode) => source.id === branchNodeId || isDeadSource(source);
  for (const orphanId of orphanedIds) {
    const target = nodes.find((candidate) => candidate.id === orphanId);
    if (!target || target.nodeStatus !== 'Pending') continue;
    if (sourcesOf(target, nodes, edges).every(dead)) {
      target.nodeStatus = 'Orphaned';
      orphanedNow.push(orphanId);
    }
  }
  for (const orphanId of orphanedIds) {
    orphanedNow.push(...cascadeOrphan(orphanId, nodes, edges));
  }
  return orphanedNow;
}
