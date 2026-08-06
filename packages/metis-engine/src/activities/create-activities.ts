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
import {
  cloudParkJobId,
  isCompleted,
  isUnimplemented,
  signalPark,
  type CapabilityGatewayClient,
  type CredentialPort,
  type EventSink,
  type NodeExecPort,
  type NodeStateItem,
  type WorkflowEventName,
} from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import { ApplicationFailure } from '@temporalio/activity';
import { activityAttempt, maybeHeartbeat, pollPause, resolveOrRefuse } from './activity-context.js';
import { replaceConfigStateData } from '../substitution/state.js';
import { checkSwitchCondition, partitionTargets, type SwitchConfig } from '../nodes/switch.js';
import { logicBranch, type LogicConfig } from '../nodes/logic.js';
import { runFlowNode } from '../nodes/flow-inline.js';
import { CONFIG_ONLY_NODE_TYPES, validateDefinition } from '../validation.js';
import type {
  BuildApiResponseRequest,
  CancelCloudJobRequest,
  EngineActivities,
  ExecuteNodeRequest,
  ExecuteNodeResult,
  HelixWorkflowInput,
  InitiateWorkflowResult,
  MarkNodesOrphanedRequest,
  MarkNodeWaitingRequest,
  PollCloudJobRequest,
  WorkflowLifecycleRequest,
  WorkflowNode,
} from '../types.js';
import { oversizeOutput, policyAttempts } from '../types.js';

/** Map a handler's numeric status to the workflow's internal outcome. */
function classifyStatus(status: number): ExecuteNodeResult['outcome'] {
  if (isCompleted(status)) return 'completed';
  if (isUnimplemented(status)) return 'unimplemented';
  return 'failed';
}

/** One dispatch's outcome, before the log line and the event are written. */
type DispatchResult = Pick<
  ExecuteNodeResult,
  'outcome' | 'output' | 'error' | 'attempts' | 'jobId' | 'park'
> & {
  binding?: 'local' | 'cloud' | 'local-degraded';
  /** The dispatch's own message. A failure's already travels as `error`; this
   *  keeps a COMPLETED one, which a degraded bind needs: the sentence saying
   *  why the cloud did not take the step exists nowhere else. */
  message?: string;
};

/**
 * Dispatch a handler node through the port under its policy: a bounded
 * retry loop with optional backoff, each attempt raced against the
 * policy timeout. Inline control primitives never come through here.
 */
async function executeHandlerWithPolicy(
  nodes: NodeExecPort,
  request: ExecuteNodeRequest,
  resolvedConfig: Record<string, unknown>,
): Promise<DispatchResult> {
  const { node } = request;
  const policy = node.policy ?? {};
  const maxAttempts = policyAttempts(policy);
  const timeoutMs = Math.max(0, (policy.timeoutSeconds ?? 0) * 1000);
  const backoffMs = Math.max(0, (policy.backoffSeconds ?? 0) * 1000);
  const runOnce = (signal: AbortSignal) =>
    nodes.execute({
      signal,
      nodeRef: {
        id: node.id,
        type: node.type,
        version: node.version,
        config: resolvedConfig,
        signalParams: request.signalParams,
      },
      tenantId: request.tenantId,
      executionId: request.executionId,
      workflowId: request.workflowId,
      inputData: request.inputData,
      workflowState: { states: request.states as unknown as NodeStateItem[] },
      targets: request.targets,
      routing: request.routing,
      // Same on every retry of this order, different for the next (NodePolicy).
      idempotencyKey: policy.idempotencyKey ? `${request.executionId}:${node.id}:${policy.idempotencyKey}` : undefined,
    });

  let exec;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    exec = await withTimeout(runOnce, timeoutMs, {
      status: 504,
      message: `timed out after ${policy.timeoutSeconds}s`,
    });
    if (classifyStatus(exec.status) !== 'failed' || attempts >= maxAttempts) break;
    if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  // A park-mode cloud dispatch answers 202 + a park action: the workflow
  // awaits the job durably instead of this activity polling it.
  const parkedJobId = cloudParkJobId(exec);
  if (parkedJobId) {
    return { outcome: 'parked', jobId: parkedJobId, attempts, binding: exec.binding };
  }
  // The other park: the handler wants an answer from outside the run. The
  // wait belongs to the workflow, not to this activity, whose budget is
  // minutes while a sign-off is measured in days.
  const park = signalPark(exec);
  if (park) return { outcome: 'parked', park, attempts, binding: exec.binding };
  const outcome = classifyStatus(exec.status);
  return {
    outcome,
    output: isCompleted(exec.status)
      ? (exec.nodeData?.data ?? exec.nodeData?.result ?? exec.nodeData)
      : undefined,
    error: outcome === 'failed' ? { message: exec.message } : undefined,
    attempts,
    binding: exec.binding,
    message: exec.message,
  };
}

/**
 * Race work against a timeout, resolving the timeout value when it wins and
 * telling the loser to stop. The abort is the half that matters: the losing
 * dispatch used to run on to completion, so the next attempt's request went
 * out while the first was still in flight - one node, two concurrent side
 * effects, and `idempotencyKey` is opt-in. A handler that cannot be cancelled
 * simply ignores the signal and is no worse off than before.
 */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  timeoutValue: T,
): Promise<T> {
  const controller = new AbortController();
  if (ms <= 0) return work(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`node dispatch timed out after ${ms}ms`));
      resolve(timeoutValue);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface EnginePorts {
  store: WorkflowStore;
  events: EventSink;
  nodes: NodeExecPort;
  credentials: CredentialPort;
  /** The capability gateway, for the parked-node job poll (uplift only). */
  gateway?: CapabilityGatewayClient;
}

const CLOUD_POLL_MS = 2_000;

/**
 * Build the engine's activity surface from the ports.
 * Activities are the only place substrate is touched: the workflow
 * code stays deterministic and reaches everything through these.
 */
export function createActivities(ports: EnginePorts): EngineActivities {
  /** Every log row carries the attempt that wrote it (see activityAttempt). */
  const appendLog = (log: Parameters<WorkflowStore['appendExecutionLog']>[0]) =>
    ports.store.appendExecutionLog({ ...log, activityAttempt: activityAttempt() });

  const emit = (
    name: WorkflowEventName,
    request: { tenantId: string; workflowId?: string; executionId?: string },
    nodeId?: string,
    payload?: Record<string, unknown>,
  ) => {
    ports.events.emit({
      name,
      tenantId: request.tenantId,
      workflowId: request.workflowId,
      executionId: request.executionId,
      nodeId,
      timestamp: new Date().toISOString(),
      payload,
    });
  };

  return {
    async initiateWorkflow(input: HelixWorkflowInput): Promise<InitiateWorkflowResult> {
      const validation = validateDefinition(input.definition, {
        kind: input.graphKind ?? 'workflow',
        level: 'start',
      });
      if (!validation.valid) {
        const reason = `invalid definition: ${validation.errors.join('; ')}`;
        await ports.store.writeExecutionMeta({
          tenantId: input.tenantId,
          executionId: input.executionId,
          workflowId: input.workflowId,
          status: 'failed',
          startTime: new Date().toISOString(),
          failureReason: reason,
        });
        emit('workflow.execution.failed', input, undefined, { reason });
        throw ApplicationFailure.nonRetryable(reason, 'InvalidDefinition');
      }
      await ports.store.writeExecutionMeta({
        tenantId: input.tenantId,
        executionId: input.executionId,
        workflowId: input.workflowId,
        status: 'running',
        startTime: new Date().toISOString(),
        // Which definition this run executes - versioning for runs.
        ...(input.definitionVersion !== undefined
          ? { definitionVersion: input.definitionVersion, definitionChangeset: input.definitionChangeset }
          : {}),
      });
      emit('workflow.execution.started', input);
      return {
        nodes: input.definition.nodes.map((node) => ({
          ...node,
          // ponytail: the Helix-exact save shape holds config under
          // node.data.config; read from either location so the flat
          // (engine/test) and Helix node shapes both run unchanged.
          config: node.config ?? (node as { data?: { config?: Record<string, unknown> } }).data?.config,
          // Policy follows the same convention (the inspector saves data.policy).
          policy: node.policy ?? (node as { data?: { policy?: WorkflowNode['policy'] } }).data?.policy,
          // Config-only nodes never execute: they enter as satisfied
          // sources so the walk starts below them (origin behaviour).
          nodeStatus: CONFIG_ONLY_NODE_TYPES.has(node.type.toLowerCase()) ? 'Complete' : 'Pending',
        })),
        edges: input.definition.edges,
      };
    },

    async executeNode(request: ExecuteNodeRequest): Promise<ExecuteNodeResult> {
      const { tenantId, executionId, node, states, sequence } = request;
      emit('workflow.node.started', request, node.id);
      await appendLog({
        tenantId,
        executionId,
        sequence: sequence * 10 + 1,
        nodeId: node.id,
        nodeType: node.type,
        event: 'workflow.node.started',
        at: new Date().toISOString(),
      });

      const substituted = replaceConfigStateData(executionId, tenantId, node.config ?? {}, {
        states,
      });
      const resolved = await resolveOrRefuse(substituted, tenantId, ports.credentials);
      const nodeType = node.type.toLowerCase();

      let result: DispatchResult;
      if (nodeType === 'signal') {
        // Inline control primitive: the park happened in the workflow;
        // this records the resume and surfaces the signal params as the
        // node's output for downstream substitution.
        emit('workflow.signal.received', request, node.id);
        result = { outcome: 'completed', output: request.signalParams ?? {} };
      } else if (nodeType === 'waituntil') {
        // The sleep happened in the workflow; completing here records it.
        result = { outcome: 'completed', output: {} };
      } else if (nodeType === 'switch') {
        // Inline control primitive: evaluated in-process,
        // never dispatched through NodeExecPort. The workflow applies the
        // returned partition to orphan the losing branches.
        const config = (resolved ?? {}) as { switchOptions?: SwitchConfig[] };
        const selectedSources = checkSwitchCondition(config.switchOptions, request.inputData);
        const partition = partitionTargets(request.targets ?? [], selectedSources);
        result = {
          outcome: 'completed',
          output: { selectedSources, ...partition },
        };
      } else if (nodeType === 'logic') {
        // Inline control primitive: a predicate tree (AND/OR/NOT) decides a
        // 'true'/'false' branch; targets on the other handle are orphaned via
        // the same partition mechanism as switch.
        const branch = logicBranch((resolved ?? {}) as LogicConfig, request.inputData ?? {});
        const selectedSources = [branch];
        const partition = partitionTargets(request.targets ?? [], selectedSources);
        result = {
          outcome: 'completed',
          output: { branchTaken: branch, selectedSources, ...partition },
        };
      } else {
        // The n8n-gap flow nodes (noop/stopanderror/merge/loop/filter/compare)
        // run inline via the dispatcher; branch-shaped ones partition targets.
        // Everything else dispatches through the port, which speaks the full
        // Helix contract (status + nodeData with stateItems); the mapping to
        // {outcome, output} and the node's policy (retries/backoff/timeout)
        // live in the helper. Inline control primitives never retry.
        result =
          runFlowNode(nodeType, resolved, request) ??
          (await executeHandlerWithPolicy(
            ports.nodes,
            request,
            (resolved ?? {}) as Record<string, unknown>,
          ));
      }

      // Parked: the job was accepted; the workflow marks the wait and the
      // final line lands when pollCloudJob reaches the terminal state.
      if (result.outcome === 'parked') {
        return { outcome: 'parked', jobId: result.jobId, park: result.park };
      }

      const oversize = result.outcome === 'completed' ? oversizeOutput(result.output) : undefined;
      if (oversize !== undefined) {
        result = { outcome: 'failed', error: { message: oversize }, attempts: result.attempts, binding: result.binding };
      }

      const eventByOutcome: Record<string, WorkflowEventName> = {
        completed: 'workflow.node.completed',
        unimplemented: 'workflow.node.unimplemented',
        failed: 'workflow.node.failed',
      };
      const eventName = eventByOutcome[result.outcome] ?? 'workflow.node.failed';
      emit(eventName, request, node.id);
      await appendLog({
        tenantId,
        executionId,
        sequence: sequence * 10 + 2,
        nodeId: node.id,
        nodeType: node.type,
        event: eventName,
        outcome: result.outcome,
        output: result.outcome === 'completed' ? result.output : undefined,
        error: result.error,
        attempts: result.attempts,
        binding: result.binding,
        // Only the degraded bind stores its message: a completed step's "ok"
        // says nothing, but a degraded one's names what the cloud would not do
        // and what to change instead. The outcome is 'completed', so `error` is
        // rightly empty and this is the only field the run views can read it
        // from - without it the canvas can only blame the network.
        degradedReason: result.binding === 'local-degraded' ? result.message : undefined,
        at: new Date().toISOString(),
      });

      // A degraded bind (cloud chosen, ran here instead) marks the whole run
      // so the run views can say so without scanning every log line.
      if (result.binding === 'local-degraded') {
        await ports.store.updateExecutionMeta(tenantId, executionId, { degraded: true });
      }

      return {
        outcome: result.outcome,
        output: result.output,
        error: result.error,
        attempts: result.attempts,
      };
    },

    async pollCloudJob(request: PollCloudJobRequest): Promise<ExecuteNodeResult> {
      const { tenantId, executionId, nodeId, nodeType, jobId, sequence } = request;
      if (!ports.gateway) {
        return { outcome: 'failed', error: { message: 'no cloud gateway configured' } };
      }
      const finish = async (
        outcome: 'completed' | 'failed',
        output?: unknown,
        message?: string,
      ): Promise<ExecuteNodeResult> => {
        const eventName: WorkflowEventName =
          outcome === 'completed' ? 'workflow.node.completed' : 'workflow.node.failed';
        emit(eventName, request, nodeId);
        await appendLog({
          tenantId,
          executionId,
          sequence: sequence * 10 + 2,
          nodeId,
          nodeType,
          event: eventName,
          outcome,
          output: outcome === 'completed' ? output : undefined,
          error: message ? { message } : undefined,
          binding: 'cloud',
          at: new Date().toISOString(),
        });
        return {
          outcome,
          output,
          error: message ? { message } : undefined,
        };
      };
      for (;;) {
        const job = await ports.gateway.job(jobId);
        maybeHeartbeat();
        if (job.status === 'done') return finish('completed', job.result ?? job.manifest ?? {});
        if (job.status === 'failed' || job.status === 'cancelled') {
          return finish('failed', undefined, job.error ?? `cloud job ${job.status}`);
        }
        await pollPause(CLOUD_POLL_MS);
      }
    },

    async cancelCloudJob(request: CancelCloudJobRequest): Promise<void> {
      await ports.gateway?.cancel(request.jobId).catch(() => undefined);
    },

    async buildApiResponse(
      request: BuildApiResponseRequest,
    ): Promise<{ statusCode: number; body: unknown }> {
      // apiend's statusCode sets the HTTP status (default 200); the body is
      // either an upstream node's output (sourcedata) or a templated object
      // (mappeddata).
      const statusCode = Number(request.apiendConfig.statusCode) || 200;
      const responseType = String(request.apiendConfig.responseType ?? 'sourcedata').toLowerCase();
      if (responseType === 'mappeddata') {
        const mapping = request.apiendConfig.responseMapping ?? {};
        const substituted = replaceConfigStateData(request.executionId, request.tenantId, mapping, {
          states: request.states,
        });
        const body = await resolveOrRefuse(substituted, request.tenantId, ports.credentials);
        return { statusCode, body };
      }
      const responseNodeId = String(
        request.apiendConfig.responseNodeId ?? request.sourceNodeId ?? '',
      );
      const entry = request.states.find((state) => state.nodeId === responseNodeId);
      return { statusCode, body: entry?.stateData?.data };
    },

    async markNodesOrphaned(request: MarkNodesOrphanedRequest): Promise<void> {
      for (const nodeId of request.nodeIds) {
        emit('workflow.node.orphaned', request, nodeId);
      }
      await appendLog({
        tenantId: request.tenantId,
        executionId: request.executionId,
        sequence: request.sequence * 10 + 3,
        nodeIds: request.nodeIds,
        event: 'workflow.node.orphaned',
        at: new Date().toISOString(),
      });
    },

    async markNodeWaiting(request: MarkNodeWaitingRequest): Promise<void> {
      emit('workflow.node.waiting', request, request.nodeId, {
        signalType: request.signalType,
        until: request.until,
        details: request.details,
      });
      await appendLog({
        tenantId: request.tenantId,
        executionId: request.executionId,
        // The park's own slot: started(+1)/completed(+2) must never overwrite
        // it - the waiting record is history ("parked here"), not just state.
        sequence: request.sequence * 10,
        nodeId: request.nodeId,
        nodeType: request.nodeType,
        event: 'workflow.node.waiting',
        signalType: request.signalType,
        until: request.until,
        details: request.details,
        at: new Date().toISOString(),
      });
    },

    async completeWorkflow(request: WorkflowLifecycleRequest): Promise<void> {
      await ports.store.updateExecutionMeta(request.tenantId, request.executionId, {
        status: 'completed',
        endTime: new Date().toISOString(),
      });
      emit('workflow.execution.completed', request);
    },

    async failWorkflow(request: WorkflowLifecycleRequest): Promise<void> {
      await ports.store.updateExecutionMeta(request.tenantId, request.executionId, {
        status: 'failed',
        endTime: new Date().toISOString(),
        failureReason: request.reason,
      });
      emit('workflow.execution.failed', request, undefined, { reason: request.reason });
    },

    async cancelWorkflow(request: WorkflowLifecycleRequest): Promise<void> {
      await ports.store.updateExecutionMeta(request.tenantId, request.executionId, {
        status: 'cancelled',
        endTime: new Date().toISOString(),
        cancelReason: request.reason,
      });
      emit('workflow.execution.cancelled', request, undefined, { reason: request.reason });
    },
  };
}
