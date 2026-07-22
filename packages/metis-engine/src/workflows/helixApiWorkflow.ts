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
 * helixApiWorkflow: the synchronous API workflow. The graph starts at an apiconfig node and ends at exactly one
 * apiend node whose output is the response; the whole run is bounded by
 * a deadline. As in the origin, this runner is simpler than
 * helixWorkflow: fail-fast, no signal parks.
 */
import { proxyActivities, sleep } from '@temporalio/workflow';
import { getWaitTimeMs } from '../nodes/waituntil.js';
import { getAvailableNodes, isDone, sourcesOf } from './graph.js';
import type {
  EngineActivities,
  HelixApiWorkflowResult,
  HelixWorkflowInput,
  NodeStateEntry,
  RuntimeNode,
} from '../types.js';

const activities = proxyActivities<EngineActivities>({
  startToCloseTimeout: '2 minutes',
});

const DEFAULT_DEADLINE_MS = 120_000;

export async function helixApiWorkflow(input: HelixWorkflowInput): Promise<HelixApiWorkflowResult> {
  const prepared = await activities.initiateWorkflow({ ...input, graphKind: 'api' });
  const nodes = prepared.nodes;
  const edges = prepared.edges;
  const states: NodeStateEntry[] = [];
  // Seed the request body onto the apiconfig node (which never executes) so
  // downstream {{node-<apiconfig>.data.*}} references resolve to what the
  // caller sent - mirrors helixWorkflow's trigger-config seeding.
  for (const node of nodes) {
    if (node.nodeStatus === 'Complete' && node.type.toLowerCase() === 'apiconfig') {
      states.push({
        nodeId: node.id,
        stateId: 'trigger',
        stateData: { status: 200, data: input.input ?? {} },
      });
    }
  }
  let sequence = 0;
  let failureReason: string | undefined;

  async function runNode(node: RuntimeNode): Promise<void> {
    node.nodeStatus = 'InProgress';
    sequence += 1;
    if (node.type.toLowerCase() === 'signal') {
      failureReason = `signal nodes are not supported in api workflows (${node.id})`;
      return;
    }
    if (node.type.toLowerCase() === 'waituntil') {
      const waitMs = getWaitTimeMs(node.config, Date.now());
      if (waitMs > 0) await sleep(waitMs);
    }
    const result = await activities.executeNode({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      node: { id: node.id, type: node.type, version: node.version, config: node.config },
      states,
      sequence,
    });
    if (result.outcome !== 'completed') {
      // Fail-fast, including unimplemented (the origin api walker
      // treats a 501 as terminal).
      failureReason =
        result.error?.message ?? `node ${node.id} did not complete (${result.outcome})`;
      return;
    }
    node.nodeStatus = 'Complete';
    states.push({
      nodeId: node.id,
      stateId: String(sequence),
      stateData: { status: 200, data: result.output },
    });
  }

  async function walk(): Promise<void> {
    let wave = getAvailableNodes(nodes, edges);
    while (wave.length > 0 && failureReason === undefined) {
      for (const node of wave) {
        if (failureReason !== undefined) return;
        if (!sourcesOf(node, nodes, edges).every((source) => isDone(source))) continue;
        await runNode(node);
      }
      wave = getAvailableNodes(nodes, edges);
    }
  }

  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  let timedOut = false;
  await Promise.race([
    walk(),
    sleep(deadlineMs).then(() => {
      timedOut = true;
    }),
  ]);

  if (timedOut && failureReason === undefined) {
    failureReason = `api workflow deadline exceeded after ${deadlineMs}ms`;
  }
  if (failureReason !== undefined) {
    await activities.failWorkflow({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      reason: failureReason,
    });
    return { status: 'failed' };
  }

  // Read apiend from the prepared nodes (config normalised from either the flat
  // or the Helix data.config shape), not the raw definition where config may
  // sit under data.config and be missed.
  const apiend = nodes.find((node) => node.type.toLowerCase() === 'apiend');
  const sourceEdge = edges.find((edge) => edge.target === apiend?.id);
  const built = await activities.buildApiResponse({
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    executionId: input.executionId,
    apiendConfig: apiend?.config ?? {},
    sourceNodeId: sourceEdge?.source,
    states,
  });

  await activities.completeWorkflow({
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    executionId: input.executionId,
  });
  return { status: 'completed', response: built.body, statusCode: built.statusCode };
}
