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
 * Engine domain types. This module is imported by workflow code, so it
 * must stay free of runtime imports (pure types and constants only).
 *
 * The canonical workflow shape is flat nodes[] and edges[] with
 * XYFlow-native source/target edge fields (PLAN.md D-04).
 */

/**
 * Per-node execution policy (the inspector's Policy tab). Retries, backoff
 * and timeout wrap the handler call inside the executeNode activity;
 * onFailure decides whether a failed node halts the run (default) or lets
 * the walk continue.
 */
export interface NodePolicy {
  retries?: number;
  backoffSeconds?: number;
  timeoutSeconds?: number;
  onFailure?: 'halt' | 'continue';
}

export interface WorkflowNode {
  id: string;
  type: string;
  version?: string;
  config?: Record<string, unknown>;
  policy?: NodePolicy;
}

export interface WorkflowEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** The workflow-level cloud-routing setting: the "allow cloud" toggle and
   *  the consent stamp. Cloud never binds without both (plus a node choice). */
  cloudRouting?: WorkflowCloudRouting;
}

export interface WorkflowCloudRouting {
  enabled?: boolean;
  consentAt?: string;
}

/** Cloud-routing choice carried to one dispatch (structurally the ports'
 *  CapabilityRouting; kept local because this module must stay import-free). */
export interface CloudRoutingContext {
  enabled?: boolean;
  consentAt?: string;
  nodeMode?: 'local' | 'cloud' | 'auto';
  thresholdBytes?: number;
}

export type NodeRuntimeStatus =
  | 'Pending'
  | 'InProgress'
  | 'Complete'
  | 'Failed'
  | 'Orphaned'
  | 'Cancelled';

export interface RuntimeNode extends WorkflowNode {
  nodeStatus: NodeRuntimeStatus;
  signalReceived?: boolean;
  signalParams?: unknown;
}

/** Default wait on a parked signal node: 24 hours. */
export const SIGNAL_DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface HelixSignalPayload {
  signalType: string;
  signalParams?: unknown;
}

export interface HelixCancelSignalPayload {
  cancelledBy: string;
  reason?: string;
}

export interface HelixWorkflowInput {
  tenantId: string;
  workflowId: string;
  executionId: string;
  definition: WorkflowDefinition;
  input?: Record<string, unknown>;
  /** Set by the workflow runners; drives start-time validation. */
  graphKind?: 'workflow' | 'api';
  /** Bounded deadline for the synchronous api workflow (default 120s). */
  deadlineMs?: number;
  /** Pre-seeded node states (a loop child inherits its parent's states so
   *  body references to outside-loop nodes still resolve). */
  seedStates?: NodeStateEntry[];
  /** The definition version/changeset this run executes (stamped on meta). */
  definitionVersion?: number;
  definitionChangeset?: number;
  /** Return the leaf nodes' outputs in HelixWorkflowResult.outputs (capped);
   *  set by the loop parent so each iteration yields a result. */
  collectLeafOutputs?: boolean;
}

export interface HelixApiWorkflowResult {
  status: 'completed' | 'failed';
  /** The HTTP response body apiend produced (sourcedata output or mapped object). */
  response?: unknown;
  /** The HTTP status code apiend set (default 200). */
  statusCode?: number;
}

export interface BuildApiResponseRequest {
  tenantId: string;
  workflowId: string;
  executionId: string;
  apiendConfig: Record<string, unknown>;
  sourceNodeId?: string;
  states: NodeStateEntry[];
}

export interface HelixWorkflowResult {
  status: 'completed' | 'failed' | 'cancelled';
  outputs?: Record<string, unknown>;
}

export interface NodeStateEntry {
  nodeId: string;
  stateId: string;
  stateData?: { status: number; data: unknown };
}

export interface InitiateWorkflowResult {
  nodes: RuntimeNode[];
  edges: WorkflowEdge[];
}

export interface ExecuteNodeRequest {
  tenantId: string;
  workflowId: string;
  executionId: string;
  node: WorkflowNode;
  states: NodeStateEntry[];
  sequence: number;
  /** Outgoing targets with edge handles; supplied for inline switch nodes. */
  targets?: { id: string; handle?: string }[];
  /** Incoming sources with their orphan state; supplied for inline merge nodes
   *  (their data is read from `states`, so only ids + liveness travel here). */
  sources?: { id: string; orphaned: boolean }[];
  /** The execution input payload, for switch property resolution. */
  inputData?: Record<string, unknown>;
  /** Received signal params; supplied for inline signal nodes on resume. */
  signalParams?: unknown;
  /** Cloud-routing choice (workflow toggle + this node's override), for the
   *  capability resolver behind NodeExecPort. */
  routing?: CloudRoutingContext;
}

export interface MarkNodesOrphanedRequest {
  tenantId: string;
  workflowId: string;
  executionId: string;
  nodeIds: string[];
  sequence: number;
}

export interface MarkNodeWaitingRequest {
  tenantId: string;
  workflowId: string;
  executionId: string;
  nodeId: string;
  nodeType: string;
  signalType?: string;
  /** waituntil: the ISO time the node sleeps until (whereabouts display). */
  until?: string;
  sequence: number;
}

export interface SwitchNodeOutput {
  selectedSources: string[];
  selectedTargetIds: string[];
  orphanedTargetIds: string[];
}

export interface ExecuteNodeResult {
  /** 'parked' = a cloud job was accepted; the workflow awaits pollCloudJob. */
  outcome: 'completed' | 'failed' | 'unimplemented' | 'parked';
  output?: unknown;
  error?: { message: string; code?: string };
  /** How many attempts the policy retry loop used (handler nodes only). */
  attempts?: number;
  /** The accepted cloud job handle (outcome 'parked' only). */
  jobId?: string;
}

export interface PollCloudJobRequest {
  tenantId: string;
  workflowId: string;
  executionId: string;
  nodeId: string;
  nodeType: string;
  jobId: string;
  sequence: number;
}

export interface CancelCloudJobRequest {
  jobId: string;
}

export interface WorkflowLifecycleRequest {
  tenantId: string;
  workflowId: string;
  executionId: string;
  reason?: string;
}

/** The activity surface the workflows proxy. */
export interface EngineActivities {
  initiateWorkflow(input: HelixWorkflowInput): Promise<InitiateWorkflowResult>;
  executeNode(request: ExecuteNodeRequest): Promise<ExecuteNodeResult>;
  /** Heartbeated long-poll of an accepted cloud job to its terminal state.
   *  Runs under its own 24h activity budget; the jobId rides workflow
   *  history, so a worker restart resumes the same job for free. */
  pollCloudJob(request: PollCloudJobRequest): Promise<ExecuteNodeResult>;
  /** Best-effort cancel of a cloud job (the run was cancelled). */
  cancelCloudJob(request: CancelCloudJobRequest): Promise<void>;
  markNodeWaiting(request: MarkNodeWaitingRequest): Promise<void>;
  markNodesOrphaned(request: MarkNodesOrphanedRequest): Promise<void>;
  buildApiResponse(request: BuildApiResponseRequest): Promise<{ statusCode: number; body: unknown }>;
  completeWorkflow(request: WorkflowLifecycleRequest): Promise<void>;
  failWorkflow(request: WorkflowLifecycleRequest): Promise<void>;
  cancelWorkflow(request: WorkflowLifecycleRequest): Promise<void>;
}
