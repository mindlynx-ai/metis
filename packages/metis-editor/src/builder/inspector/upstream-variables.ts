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
 * The variables an upstream step passes to the one being configured. We walk
 * edges backwards from the target node ring by ring (direct parents first),
 * so the closest data is offered first; runtime resolution is global, but the
 * picker only offers what actually flows in. Each variable carries the
 * canonical `{{node-<uuid>.data.<key>}}` reference the engine resolves.
 *
 * ponytail: BFS over the real graph (the origin shipped only an array-order
 * approximation). Cap the walk so a pathological cycle can never spin.
 */
import type { CatalogueEntry, JsonSchema, WorkflowEdge, WorkflowNode } from '../../api.js';

const MAX_DISTANCE = 12;

export interface UpstreamVariable {
  key: string;
  type?: string;
  reference: string;
}

export interface UpstreamSource {
  nodeId: string;
  label: string;
  category: string;
  distance: number;
  variables: UpstreamVariable[];
}

/** Follow one alias hop so an aliased node type inherits its target's schema. */
export function entryFor(catalogue: CatalogueEntry[], node: WorkflowNode): CatalogueEntry | undefined {
  const direct = catalogue.find((candidate) => candidate.type === node.type);
  if (direct?.alias_of) {
    return catalogue.find((candidate) => candidate.type === direct.alias_of) ?? direct;
  }
  return direct;
}

/** Manual output keys declared on the node instance (from a pasted sample). */
function declaredFields(node: WorkflowNode): { key: string; type?: string }[] {
  const outputs = node.data?.outputs;
  if (!Array.isArray(outputs)) return [];
  const fields: { key: string; type?: string }[] = [];
  for (const spec of outputs) {
    const rows = (spec as { manualData?: { key?: string; type?: string }[] })?.manualData;
    for (const row of rows ?? []) {
      if (row?.key && !fields.some((field) => field.key === row.key)) {
        fields.push({ key: row.key, type: row.type });
      }
    }
  }
  return fields;
}

/** Property names a node type's outputSchema advertises. */
function schemaFields(schema: JsonSchema | undefined): { key: string; type?: string }[] {
  return Object.entries(schema?.properties ?? {}).map(([key, property]) => ({
    key,
    type: property.type,
  }));
}

function variablesFor(node: WorkflowNode, entry: CatalogueEntry | undefined): UpstreamVariable[] {
  // Precedence: instance-declared outputs > catalogue schema > a generic
  // whole-payload chip so every upstream step always offers something.
  const fields = declaredFields(node);
  const chosen = fields.length > 0 ? fields : schemaFields(entry?.outputSchema);
  if (chosen.length === 0) {
    return [{ key: 'data', reference: `{{${node.id}.data}}` }];
  }
  return chosen.map((field) => ({
    key: field.key,
    type: field.type,
    reference: `{{${node.id}.data.${field.key}}}`,
  }));
}

export function collectUpstreamVariables(input: {
  nodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  catalogue: CatalogueEntry[];
}): UpstreamSource[] {
  const { nodeId, nodes, edges, catalogue } = input;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentsOf = (id: string) =>
    edges.filter((edge) => edge.target === id).map((edge) => edge.source);

  const distance = new Map<string, number>();
  let ring = parentsOf(nodeId);
  let depth = 1;
  while (ring.length > 0 && depth <= MAX_DISTANCE) {
    const next: string[] = [];
    for (const id of ring) {
      if (id === nodeId || distance.has(id)) continue;
      distance.set(id, depth);
      next.push(...parentsOf(id));
    }
    ring = next;
    depth += 1;
  }

  const sources: UpstreamSource[] = [];
  for (const [id, dist] of distance) {
    const node = byId.get(id);
    if (!node) continue;
    const entry = entryFor(catalogue, node);
    sources.push({
      nodeId: id,
      label: node.data?.label ?? node.type,
      category: entry?.category ?? 'app',
      distance: dist,
      variables: variablesFor(node, entry),
    });
  }
  // Closest first; stable by label within a ring for a predictable order.
  sources.sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label));
  return sources;
}
