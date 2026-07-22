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
 * Dagre auto-layout for the builder canvas (the react-flow skill's Dagre
 * pattern): compute tidy positions from nodes + edges, return the new
 * {id, position} for each. The flow store applies them and the canvas
 * re-derives; a pure function so it stays testable and state-free.
 */
import dagre from '@dagrejs/dagre';
import type { WorkflowEdge, WorkflowNode } from '../api.js';

const NODE_WIDTH = 232;
const NODE_HEIGHT = 96;

export type LayoutDirection = 'LR' | 'TB';

export interface LayoutPosition {
  id: string;
  position: { x: number; y: number };
}

/** Position the graph with Dagre in the given direction (LR or TB). */
export function layoutPositions(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  direction: LayoutDirection,
): LayoutPosition[] {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, ranksep: 80, nodesep: 44 });
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return nodes.map((node) => {
    const positioned = graph.node(node.id);
    // Dagre returns the node centre; nodeOrigin is [0,0] so shift to top-left.
    return {
      id: node.id,
      position: { x: positioned.x - NODE_WIDTH / 2, y: positioned.y - NODE_HEIGHT / 2 },
    };
  });
}
