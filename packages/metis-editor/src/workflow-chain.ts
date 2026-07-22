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
 * The order to preview a workflow's steps in a list card: start (roots with no
 * incoming edge) first, then follow the edges, so a linear flow reads left to
 * right. Truncated to `max` with an overflow count for the "+n" chip.
 */
import type { WorkflowEdge, WorkflowNode } from './api.js';

export function chainPreview(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  max: number,
): { shown: WorkflowNode[]; overflow: number } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hasIncoming = new Set(edges.map((edge) => edge.target));
  const childrenOf = (id: string) => edges.filter((edge) => edge.source === id).map((edge) => edge.target);

  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    ordered.push(byId.get(id)!);
    for (const child of childrenOf(id)) visit(child);
  };

  // Roots first (preserving node order among roots), then any stragglers so a
  // disconnected node is never dropped from the count.
  for (const node of nodes) if (!hasIncoming.has(node.id)) visit(node.id);
  for (const node of nodes) visit(node.id);

  return { shown: ordered.slice(0, max), overflow: Math.max(0, ordered.length - max) };
}
