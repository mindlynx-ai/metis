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
 * Pure builder (deterministic, workflow-bundled): the executeNode request
 * for one dispatch, including its cloud-routing choice.
 */
import { cloudRoutingFor } from './routing.js';
import type {
  ExecuteNodeRequest,
  HelixWorkflowInput,
  NodeStateEntry,
  RuntimeNode,
  WorkflowEdge,
} from '../types.js';

export function buildExecuteRequest(
  input: HelixWorkflowInput,
  states: NodeStateEntry[],
  nodes: RuntimeNode[],
  edges: WorkflowEdge[],
  node: RuntimeNode,
  nodeType: string,
  isBranch: boolean,
  nodeSequence: number,
): ExecuteNodeRequest {
  return {
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    executionId: input.executionId,
    node: { id: node.id, type: node.type, version: node.version, config: node.config, policy: node.policy },
    states,
    sequence: nodeSequence,
    targets: isBranch
      ? edges
          .filter((edge) => edge.source === node.id)
          .map((edge) => ({ id: edge.target, handle: edge.sourceHandle }))
      : undefined,
    // A merge node joins its predecessors: pass their ids + liveness so the
    // activity can read the LIVE sources' data from `states` (an orphaned
    // branch never pollutes the merged payload).
    sources:
      nodeType === 'merge'
        ? edges
            .filter((edge) => edge.target === node.id)
            .map((edge) => ({
              id: edge.source,
              orphaned: nodes.find((candidate) => candidate.id === edge.source)?.nodeStatus === 'Orphaned',
            }))
        : undefined,
    inputData: isBranch ? input.input : undefined,
    signalParams: nodeType === 'signal' ? node.signalParams : undefined,
    routing: cloudRoutingFor(input.definition.cloudRouting, node),
  };
}
