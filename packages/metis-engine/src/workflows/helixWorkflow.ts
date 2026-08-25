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
import { condition, defineSignal, executeChild, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import { getWaitTimeMs } from '../nodes/waituntil.js';
import { LOOP_CHILD_OUTPUT_BYTES, LOOP_RESULTS_BYTES, type LoopPlan } from '../nodes/loop.js';
import {
  applySwitchPartition,
  BRANCH_NODE_TYPES,
  getAvailableNodes,
  isDone,
  loopBodyIds,
  signalTarget,
  sourcesOf,
} from './graph.js';
import { awaitCloudJob } from './cloud-park.js';
import { settleDecisions } from './decision-park.js';
import { buildExecuteRequest } from './execute-request.js';
import {
  dispatchBudgetMs,
  ENGINE_ACTIVITY_RETRY,
  SIGNAL_DEFAULT_TIMEOUT_MS,
  type EngineActivities,
  type ExecuteNodeResult,
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
  retry: ENGINE_ACTIVITY_RETRY,
});

/**
 * The dispatch proxy for ONE node: its budget is derived from its own policy,
 * because the policy's retries run inside the activity. A fixed two minutes
 * covered the bookkeeping activities above and nothing else - a node allowed
 * more than that outran its budget, Temporal retried the whole activity, and
 * the request went out again while the first was still in flight.
 * proxyActivities only builds a proxy object, so calling it per node records
 * no history and stays deterministic.
 */
const dispatchFor = (policy: RuntimeNode['policy']) =>
  proxyActivities<Pick<EngineActivities, 'executeNode'>>({
    startToCloseTimeout: dispatchBudgetMs(policy),
    retry: ENGINE_ACTIVITY_RETRY,
  });


export const helixSignal = defineSignal<[HelixSignalPayload]>('helixSignal');
export const helixCancelSignal = defineSignal<[HelixCancelSignalPayload]>('helixCancelSignal');

const TRIGGER_CONFIG_TYPES = new Set(['webhookconfig', 'scheduleconfig', 'apiconfig']);
// Branch nodes: their activity result carries selected/orphaned targets.


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

export async function helixWorkflow(started: HelixWorkflowInput): Promise<HelixWorkflowResult> {
  // A schedule registers ONE action payload and replays it at every tick, so
  // the executionId baked into that payload is the same on the thousandth fire
  // as on the first: one run row, overwritten for ever, and no history of any
  // earlier fire. Temporal has already given this run its own workflow id (for
  // a scheduled action, the action's id with the nominal fire time appended),
  // and every start path we own sets the workflow id TO the executionId, so
  // adopting the ambient id costs nothing anywhere else and gives a scheduled
  // fire an identity of its own - one Temporal answers to, so cancel,
  // terminate and the status reconciler can still find it.
  const input: HelixWorkflowInput = { ...started, executionId: workflowInfo().workflowId };
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
    const target = signalTarget(nodes, wanted);
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

  /**
   * Wait out a parked dispatch. Two things park: an accepted cloud job, and
   * a handler that needs a decision from outside the run (a sign-off). Both
   * wait durably, and both race the run's cancel signal.
   */
  async function awaitPark(
    node: RuntimeNode,
    nodeType: string,
    isBranch: boolean,
    result: ExecuteNodeResult,
    nodeSequence: number,
  ): Promise<ExecuteNodeResult | 'cancelled'> {
    if (result.jobId) return awaitCloudJob(input, node, result.jobId, nodeSequence, () => cancelled);
    if (!result.park) return result;
    return settleDecisions(input, node, result, {
      isCancelled: () => cancelled,
      // A fresh sequence per round: the first dispatch already wrote this
      // node's started line, and the log's sort key must stay unique.
      nextSequence: () => (sequence += 1),
      dispatch: (next) =>
        dispatchFor(node.policy).executeNode(
          buildExecuteRequest(input, states, nodes, edges, node, nodeType, isBranch, next),
        ),
    });
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
    let result = await dispatchFor(node.policy).executeNode(
      buildExecuteRequest(input, states, nodes, edges, node, nodeType, isBranch, nodeSequence),
    );

    // A parked dispatch waits out its cloud job or its human decision here.
    if (result.outcome === 'parked') {
      const settled = await awaitPark(node, nodeType, isBranch, result, nodeSequence);
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

    if (isBranch) await reportBranchPartition(node, result);

    await walkSuccessors(node);
  }

  /**
   * Orphan the branches a branch node did not take. A node this edition
   * cannot run took NONE of them: an approval gate that could not be
   * evaluated must not open every path below it, so the walk stops there
   * rather than guessing its way onwards to whatever moves the money.
   */
  async function reportBranchPartition(node: RuntimeNode, result: ExecuteNodeResult): Promise<void> {
    if (result.outcome === 'completed') {
      await reportSwitchOrphans(node.id, result.output as SwitchNodeOutput);
      return;
    }
    if (result.outcome !== 'unimplemented') return;
    await reportSwitchOrphans(node.id, {
      selectedSources: [],
      selectedTargetIds: [],
      orphanedTargetIds: edges.filter((edge) => edge.source === node.id).map((edge) => edge.target),
    });
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
    const resolveResult = await dispatchFor(node.policy).executeNode(
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

  async function reportSwitchOrphans(branchNodeId: string, partition: SwitchNodeOutput): Promise<void> {
    const orphanedNow = applySwitchPartition(branchNodeId, partition, nodes, edges);
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
