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
import {
  applySwitchPartition,
  BRANCH_NODE_TYPES,
  getAvailableNodes,
  isDone,
  sourcesOf,
} from './graph.js';
import { buildExecuteRequest } from './execute-request.js';
import { ENGINE_ACTIVITY_RETRY } from '../types.js';
import type {
  EngineActivities,
  ExecuteNodeResult,
  HelixApiWorkflowResult,
  HelixWorkflowInput,
  NodeStateEntry,
  RuntimeNode,
  SwitchNodeOutput,
} from '../types.js';

const activities = proxyActivities<EngineActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ENGINE_ACTIVITY_RETRY,
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
    // The SAME request builder helixWorkflow uses. Hand-rolling it here left
    // out four things a node needs and nothing said so: the run input (a code
    // node saw `input` as null, and a branch had nothing to test), the outgoing
    // targets (so a switch selected a branch and then orphaned NOTHING, and
    // every path below it ran), a merge node's sources, and the per-node retry
    // policy and cloud routing.
    const nodeType = node.type.toLowerCase();
    const isBranch = BRANCH_NODE_TYPES.has(nodeType);
    const result = await activities.executeNode(
      buildExecuteRequest(input, states, nodes, edges, node, nodeType, isBranch, sequence),
    );
    if (isBranch) await reportBranchPartition(node, edges, result);
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

  /**
   * Orphan the branches a branch node did not take, so the walker skips them
   * (`isDone` already counts Orphaned, so no other guard changes). A node this
   * edition cannot run took NONE of them, the same refusal helixWorkflow makes:
   * an approval that could not be evaluated must not open every path below it.
   */
  async function reportBranchPartition(
    node: RuntimeNode,
    graphEdges: typeof edges,
    result: ExecuteNodeResult,
  ): Promise<void> {
    let partition: SwitchNodeOutput | undefined;
    if (result.outcome === 'completed') partition = result.output as SwitchNodeOutput;
    else if (result.outcome === 'unimplemented') {
      partition = {
        selectedSources: [],
        selectedTargetIds: [],
        orphanedTargetIds: graphEdges
          .filter((edge) => edge.source === node.id)
          .map((edge) => edge.target),
      };
    }
    if (!partition) return;
    const orphanedNow = applySwitchPartition(node.id, partition, nodes, graphEdges);
    if (orphanedNow.length === 0) return;
    sequence += 1;
    await activities.markNodesOrphaned({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      nodeIds: orphanedNow,
      sequence,
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
  // Which upstream node answers, when apiend does not name one. The one that
  // actually RAN, not merely the first edge drawn into it: a branch above means
  // several nodes are wired here and only one of them is live, so first-edge
  // order decided the response and a graph whose losing branch happened to be
  // drawn first answered null. An unbranched graph has exactly one live source,
  // so this is the same answer it always gave.
  const intoEnd = edges.filter((edge) => edge.target === apiend?.id);
  const ranSource = (edge: { source: string }): boolean =>
    nodes.find((candidate) => candidate.id === edge.source)?.nodeStatus === 'Complete';
  const sourceEdge = intoEnd.find(ranSource) ?? intoEnd[0];
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
