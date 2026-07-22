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
 * helixWorkflow: the asynchronous workflow runner, ported
 * from the origin engine's graph walk:
 *
 *   - processNode recursion: a completing node walks into its ready
 *     successors as a wave (Promise.all). Readiness and the InProgress
 *     guard run synchronously between awaits, so a fan-in join runs
 *     exactly once, after every parent has finished.
 *   - getAvailableNodes: a node is ready when it is Pending and every
 *     source is Complete or Orphaned.
 *   - cascadeOrphan: BFS that orphans descendants only when all their
 *     sources are dead, protecting convergence nodes (used by switch).
 *
 * Workflow code is deterministic: substrate is reached only through
 * activities. The Helix playbook edge guards, skills and browser-setup
 * branches of the origin are deliberately not ported.
 */
import { condition, defineSignal, executeChild, proxyActivities, setHandler } from '@temporalio/workflow';
import { getWaitTimeMs } from '../nodes/waituntil.js';
import { LOOP_CHILD_OUTPUT_BYTES, LOOP_RESULTS_BYTES, type LoopPlan } from '../nodes/loop.js';
import { cascadeOrphan, getAvailableNodes, isDone, loopBodyIds, sourcesOf } from './graph.js';
import { awaitCloudJob } from './cloud-park.js';
import { buildExecuteRequest } from './execute-request.js';
import {
  SIGNAL_DEFAULT_TIMEOUT_MS,
  type EngineActivities,
  type HelixCancelSignalPayload,
  type HelixSignalPayload,
  type HelixWorkflowInput,
  type HelixWorkflowResult,
  type NodeStateEntry,
  type RuntimeNode,
  type SwitchNodeOutput,
  type WorkflowEdge,
} from '../types.js';

const activities = proxyActivities<EngineActivities>({
  startToCloseTimeout: '2 minutes',
});


export const helixSignal = defineSignal<[HelixSignalPayload]>('helixSignal');
export const helixCancelSignal = defineSignal<[HelixCancelSignalPayload]>('helixCancelSignal');

/**
 * Orphan the losing direct targets of a switch (unless another live
 * path feeds them), then cascade from each orphaned target so the
 * selected branch is never swept up (origin behaviour: the cascade
 * starts below the orphaned children, not at the switch itself).
 */
function applySwitchPartition(
  partition: SwitchNodeOutput,
  nodes: RuntimeNode[],
  edges: WorkflowEdge[],
): string[] {
  const orphanedNow: string[] = [];
  const orphanedIds = partition.orphanedTargetIds ?? [];
  for (const orphanId of orphanedIds) {
    const target = nodes.find((candidate) => candidate.id === orphanId);
    if (!target || target.nodeStatus !== 'Pending') continue;
    if (sourcesOf(target, nodes, edges).every((source) => isDone(source))) {
      target.nodeStatus = 'Orphaned';
      orphanedNow.push(orphanId);
    }
  }
  for (const orphanId of orphanedIds) {
    orphanedNow.push(...cascadeOrphan(orphanId, nodes, edges));
  }
  return orphanedNow;
}

const TRIGGER_CONFIG_TYPES = new Set(['webhookconfig', 'scheduleconfig', 'apiconfig']);
// Branch nodes: their activity result carries selected/orphaned targets.
const BRANCH_NODE_TYPES = new Set(['switch', 'logic', 'filter', 'comparedatasets']);

/**
 * ponytail: loop bodies never run in the parent walk - each iteration executes
 * them as a child workflow. Reusing Orphaned (workflow memory only, no
 * persisted orphan event) makes every walker guard skip them for free.
 */
function preOrphanLoopBodies(nodes: RuntimeNode[], edges: WorkflowEdge[]): void {
  for (const node of nodes) {
    if (node.type.toLowerCase() !== 'loop') continue;
    for (const bodyId of loopBodyIds(node.id, edges)) {
      const bodyNode = nodes.find((candidate) => candidate.id === bodyId);
      if (bodyNode && bodyNode.nodeStatus === 'Pending') bodyNode.nodeStatus = 'Orphaned';
    }
  }
}

/** The loop body subgraph as a self-contained child definition. */
function extractLoopBody(loopNodeId: string, nodes: RuntimeNode[], edges: WorkflowEdge[]) {
  const bodyIds = new Set(loopBodyIds(loopNodeId, edges));
  return {
    nodes: nodes
      .filter((candidate) => bodyIds.has(candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        version: candidate.version,
        config: candidate.config,
        policy: candidate.policy,
      })),
    edges: edges.filter((edge) => bodyIds.has(edge.source) && bodyIds.has(edge.target)),
  };
}

/**
 * The leaf nodes' outputs (for a loop child): capped CHILD-side because the
 * values land in the parent's history, so the parent's own cap alone would
 * not protect it.
 */
function collectLeafOutputsFrom(
  nodes: RuntimeNode[],
  edges: WorkflowEdge[],
  states: NodeStateEntry[],
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  let bytes = 0;
  for (const node of nodes) {
    if (node.nodeStatus !== 'Complete') continue;
    if (edges.some((edge) => edge.source === node.id)) continue;
    const latest = [...states]
      .reverse()
      .find((entry) => entry.nodeId === node.id && entry.stateData !== undefined);
    if (!latest) continue;
    const value = latest.stateData!.data;
    bytes += JSON.stringify(value ?? null).length;
    if (bytes > LOOP_CHILD_OUTPUT_BYTES) return { truncated: true };
    outputs[node.id] = value;
  }
  return outputs;
}

export async function helixWorkflow(input: HelixWorkflowInput): Promise<HelixWorkflowResult> {
  const prepared = await activities.initiateWorkflow({ ...input, graphKind: 'workflow' });
  const nodes = prepared.nodes;
  const edges = prepared.edges;
  const states: NodeStateEntry[] = [];
  // Trigger-config nodes never execute, so their payload binds here:
  // the run input becomes their state entry and downstream
  // {{node-<trigger>.data.*}} references resolve.
  for (const node of nodes) {
    if (node.nodeStatus === 'Complete' && TRIGGER_CONFIG_TYPES.has(node.type.toLowerCase())) {
      states.push({
        nodeId: node.id,
        stateId: 'trigger',
        stateData: { status: 200, data: input.input ?? {} },
      });
    }
  }
  // A loop child inherits its parent's states, so body references to
  // outside-loop upstream nodes still resolve inside the iteration.
  states.push(...(input.seedStates ?? []));
  preOrphanLoopBodies(nodes, edges);
  let sequence = 0;
  let failureReason: string | undefined;
  let cancelled = false;
  let cancelReason: string | undefined;

  setHandler(helixSignal, (payload) => {
    const wanted = String(payload.signalType ?? '').toLowerCase();
    const target = nodes.find(
      (candidate) =>
        candidate.type.toLowerCase() === 'signal' &&
        candidate.signalReceived !== true &&
        (candidate.nodeStatus === 'Pending' || candidate.nodeStatus === 'InProgress') &&
        String(candidate.config?.signalType ?? '').toLowerCase() === wanted,
    );
    if (target) {
      target.signalParams = payload.signalParams;
      target.signalReceived = true;
    }
  });

  setHandler(helixCancelSignal, (payload) => {
    cancelled = true;
    cancelReason = payload.reason ?? `cancelled by ${payload.cancelledBy}`;
    for (const node of nodes) {
      if (node.nodeStatus === 'Pending' || node.nodeStatus === 'InProgress') {
        node.nodeStatus = 'Cancelled';
      }
    }
  });

  /** Park a signal node until helixSignal, cancel or timeout. */
  async function awaitSignalNode(node: RuntimeNode): Promise<'resumed' | 'stopped'> {
    const isEntry = edges.every((edge) => edge.target !== node.id);
    const configuredType = String(node.config?.signalType ?? '').toLowerCase();
    const isManual = configuredType === 'manual' || configuredType === '';
    if (isEntry && isManual) {
      // Clicking Run IS the manual signal (origin behaviour): resume
      // immediately, seeding params from the run input.
      node.signalReceived = true;
      node.signalParams = input.input ?? {};
      return 'resumed';
    }
    await activities.markNodeWaiting({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      nodeId: node.id,
      nodeType: node.type,
      signalType: String(node.config?.signalType ?? ''),
      sequence,
    });
    const timeoutConfig = Number(node.config?.timeoutMs);
    const timeoutMs = timeoutConfig > 0 ? timeoutConfig : SIGNAL_DEFAULT_TIMEOUT_MS;
    const resumed = await condition(() => node.signalReceived === true || cancelled, timeoutMs);
    if (cancelled) return 'stopped';
    if (!resumed) {
      failureReason = `signal node ${node.id} timed out after ${timeoutMs}ms`;
      return 'stopped';
    }
    sequence += 1;
    return 'resumed';
  }

  /** Park signal nodes and sleep waituntil nodes before dispatch. */
  async function preExecute(node: RuntimeNode, nodeType: string): Promise<'go' | 'stopped'> {
    if (nodeType === 'signal' && (await awaitSignalNode(node)) === 'stopped') {
      return 'stopped';
    }
    if (nodeType === 'waituntil') {
      const waitMs = getWaitTimeMs(node.config, Date.now());
      if (waitMs > 0) {
        // Log the park so Operate can say WHERE the run is (and until when).
        await activities.markNodeWaiting({
          tenantId: input.tenantId,
          workflowId: input.workflowId,
          executionId: input.executionId,
          nodeId: node.id,
          nodeType: node.type,
          until: new Date(Date.now() + waitMs).toISOString(),
          sequence,
        });
        // Interruptible sleep: wake at the timer OR the moment the run is
        // cancelled - a plain sleep held a cancelled run parked until the
        // timer fired (days, for long waits).
        await condition(() => cancelled, waitMs);
      }
      if (cancelled) return 'stopped';
    }
    return 'go';
  }

  async function processNode(node: RuntimeNode): Promise<void> {
    if (failureReason !== undefined || cancelled) return;
    if (node.nodeStatus !== 'Pending') return;
    if (!sourcesOf(node, nodes, edges).every((source) => isDone(source))) return;
    node.nodeStatus = 'InProgress';
    sequence += 1;
    // Capture this node's sequence NOW: same-wave siblings interleave at the
    // awaits below, and the log's sort key must stay unique per node.
    const nodeSequence = sequence;

    const nodeType = node.type.toLowerCase();
    if ((await preExecute(node, nodeType)) === 'stopped') return;

    // The loop drives child workflows and owns its own bookkeeping.
    if (nodeType === 'loop') {
      await runLoopNode(node, nodeSequence);
      return;
    }

    // Branch nodes partition their outgoing targets and orphan the losing
    // branches; they need their edge handles passed as targets.
    const isBranch = BRANCH_NODE_TYPES.has(nodeType);
    let result = await activities.executeNode(
      buildExecuteRequest(input, states, nodes, edges, node, nodeType, isBranch, nodeSequence),
    );

    // A parked dispatch: the cloud accepted the job; await it durably,
    // racing the run's cancel signal (cloud-park.ts owns the mechanics).
    if (result.outcome === 'parked' && result.jobId) {
      const settled = await awaitCloudJob(input, node, result.jobId, nodeSequence, () => cancelled);
      if (settled === 'cancelled') return;
      result = settled;
    }

    if (result.outcome === 'failed') {
      if (node.policy?.onFailure === 'continue') {
        // Terminal but non-fatal (the node's policy): the failure is on the
        // log, no state entry is pushed, and the walk carries on. Downstream
        // references to this node simply do not resolve.
        node.nodeStatus = 'Failed';
        await walkSuccessors(node);
        return;
      }
      failureReason = result.error?.message ?? `node ${node.id} failed`;
      return;
    }
    node.nodeStatus = 'Complete';
    if (result.outcome === 'completed') {
      states.push({
        nodeId: node.id,
        stateId: String(sequence),
        stateData: { status: 200, data: result.output },
      });
    }

    if (isBranch && result.outcome === 'completed') {
      await reportSwitchOrphans(result.output as SwitchNodeOutput);
    }

    await walkSuccessors(node);
  }

  /**
   * Drive a loop node (REQ: n8n-gap Loop): resolve the iteration plan via the
   * activity (deterministic - the plan rides history), then run the body
   * subgraph as ONE NATIVE TEMPORAL CHILD WORKFLOW PER BATCH with a
   * deterministic id, awaited serially and fail-fast. Each iteration is a
   * real run (store row + Temporal UI). Afterwards only the `done` handle's
   * successors fire - the body was pre-orphaned in this walk.
   */
  async function runLoopNode(node: RuntimeNode, nodeSequence: number): Promise<void> {
    const resolveResult = await activities.executeNode(
      buildExecuteRequest(input, states, nodes, edges, node, 'loop', false, nodeSequence),
    );
    if (resolveResult.outcome !== 'completed') {
      failureReason = resolveResult.error?.message ?? `loop ${node.id} failed to resolve`;
      return;
    }
    const plan = resolveResult.output as LoopPlan;

    // The body subgraph becomes the child definition (single-start by the
    // loop validation rules, so the child validates cleanly).
    const bodyDef = extractLoopBody(node.id, nodes, edges);
    // Only the states the body actually references ride the child args.
    const bodyJson = JSON.stringify(bodyDef.nodes);
    const inherited = states.filter((entry) => bodyJson.includes(entry.nodeId));

    /** One iteration: run the body as a child; a string return is fatal. */
    const runIteration = async (index: number): Promise<{ entry: unknown } | string> => {
      const batch = plan.items.slice(index * plan.batchSize, (index + 1) * plan.batchSize);
      const childId = `${input.executionId}-loop-${node.id}-${index}`;
      let childResult: HelixWorkflowResult;
      try {
        childResult = await executeChild(helixWorkflow, {
          workflowId: childId,
          args: [
            {
              tenantId: input.tenantId,
              workflowId: input.workflowId,
              executionId: childId,
              definition: bodyDef,
              input: input.input,
              seedStates: [
                ...inherited,
                // The batch itself, under the LOOP's id: body configs
                // reference {{node-<loopId>.data.item}} / .items / .index.
                {
                  nodeId: node.id,
                  stateId: 'loop-item',
                  stateData: { status: 200, data: { item: batch[0], items: batch, index } },
                },
              ],
              collectLeafOutputs: true,
            },
          ],
        });
      } catch (error) {
        // Infra-level child failure (terminate/timeout/invalid definition).
        return `loop ${node.id} iteration ${index} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      // A failed child RETURNS {status:'failed'} - it never throws.
      if (childResult.status !== 'completed') {
        return `loop ${node.id} stopped: iteration ${index} ${childResult.status}`;
      }
      const outputs = childResult.outputs ?? {};
      const keys = Object.keys(outputs);
      return { entry: keys.length === 1 ? outputs[keys[0]!] : outputs };
    };

    const results: unknown[] = [];
    let resultsBytes = 0;
    let resultsTruncated = false;
    for (let index = 0; index < plan.iterations; index += 1) {
      // Cooperative cancel: stop at an iteration boundary, never mid-child.
      if (cancelled) return;
      const outcome = await runIteration(index);
      if (typeof outcome === 'string') {
        failureReason = outcome;
        return;
      }
      if (!resultsTruncated) {
        resultsBytes += JSON.stringify(outcome.entry ?? null).length;
        if (resultsBytes > LOOP_RESULTS_BYTES) resultsTruncated = true;
        else results.push(outcome.entry);
      }
    }

    node.nodeStatus = 'Complete';
    states.push({
      nodeId: node.id,
      stateId: String(nodeSequence),
      stateData: {
        status: 200,
        data: {
          iterations: plan.iterations,
          results,
          lastResult: results[results.length - 1],
          resultsTruncated,
        },
      },
    });
    await walkSuccessors(node);
  }

  async function reportSwitchOrphans(partition: SwitchNodeOutput): Promise<void> {
    const orphanedNow = applySwitchPartition(partition, nodes, edges);
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

  async function walkSuccessors(node: RuntimeNode): Promise<void> {
    const successorIds = edges.filter((edge) => edge.source === node.id).map((edge) => edge.target);
    const wave = nodes.filter(
      (candidate) =>
        successorIds.includes(candidate.id) &&
        candidate.nodeStatus === 'Pending' &&
        sourcesOf(candidate, nodes, edges).every((source) => isDone(source)),
    );
    await Promise.all(wave.map((next) => processNode(next)));
  }

  try {
    let wave = getAvailableNodes(nodes, edges);
    while (wave.length > 0 && failureReason === undefined && !cancelled) {
      await Promise.all(wave.map((node) => processNode(node)));
      wave = getAvailableNodes(nodes, edges);
    }

    if (cancelled) {
      await activities.cancelWorkflow({
        tenantId: input.tenantId,
        workflowId: input.workflowId,
        executionId: input.executionId,
        reason: cancelReason,
      });
      return { status: 'cancelled' };
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

    await activities.completeWorkflow({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      executionId: input.executionId,
    });
    if (input.collectLeafOutputs === true) {
      return { status: 'completed', outputs: collectLeafOutputsFrom(nodes, edges, states) };
    }
    return { status: 'completed' };
  } catch (error) {
    await activities.failWorkflow({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { status: 'failed' };
  }
}
