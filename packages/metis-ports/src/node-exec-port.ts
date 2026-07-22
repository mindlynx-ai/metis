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
 * The node handler contract, aligned field-for-field with Helix's
 * `NodeHandlerContext` / `NodeExecutionResult` so a handler written for one
 * engine runs in the other. A handler receives the resolved node ref plus the
 * carried workflow state (variables seeded at the start node and threaded
 * through every node), and returns a status-classified result whose `nodeData`
 * carries the referenceable output (`stateItems`) and, for control nodes, a
 * `nodeAction` / `nextNodes` signal the workflow loop interprets.
 *
 * An unknown type resolves to status 501 (unimplemented): the run does
 * not fail and the definition stays valid.
 */
import type { CapabilityRouting } from './uplift.js';

/** One carried variable: an upstream node's output keyed by state id. */
export interface NodeStateItem {
  stateId: string;
  stateData: { status: number; data: unknown };
}

/** The referenceable output envelope a handler emits. */
export interface NodeData {
  /** The primary return value (code/transform use this). */
  result?: unknown;
  /** The primary return value (integration nodes use this). */
  data?: unknown;
  /** State ids this node contributes, e.g. `<nodeId>:api`. */
  stateIds?: string[];
  /** The carried variables this node adds to the workflow state. */
  stateItems?: NodeStateItem[];
  [key: string]: unknown;
}

/** A control-flow signal the workflow loop interprets (wait / sleep / branch). */
export interface NodeActionResult {
  type: string;
  action: string;
  data: unknown;
}

export interface NodeExecutionResult {
  /** 2xx = completed, 501 = unimplemented, anything else = failed. */
  status: number;
  message: string;
  nodeData?: NodeData;
  /** Present on control nodes (signal/waituntil/switch). */
  nodeAction?: NodeActionResult;
  /** Explicit next targets (switch narrows the frontier with these). */
  nextNodes?: string[];
  /** Which backend ran the node; set by the capability resolver only.
   *  'local-degraded' = cloud was chosen but unreachable, ran here instead. */
  binding?: 'local' | 'cloud' | 'local-degraded';
}

/** The resolved node the handler runs; `config` is already substituted. */
export interface NodeRef {
  id: string;
  type: string;
  version?: string;
  config: Record<string, unknown>;
  /** Signal params delivered on resume (signal nodes). */
  signalParams?: unknown;
}

/** The carried variables: start-node seed + each upstream node's output. */
export interface WorkflowStateView {
  states: NodeStateItem[];
}

export interface NodeHandlerContext {
  nodeRef: NodeRef;
  tenantId: string;
  executionId: string;
  workflowId: string;
  /** The run input, used by predicate nodes (switch, logic). */
  inputData?: Record<string, unknown>;
  /** The carried variables from the start seed and upstream nodes. */
  workflowState: WorkflowStateView;
  /** Outgoing targets of the current node, for switch branching. */
  targets?: { id: string; handle?: string }[];
  /** The full node list, for handlers that inspect the graph. */
  workflowNodes?: { id: string; type: string; config?: Record<string, unknown> }[];
  /** Cloud-routing choice for this dispatch (workflow toggle + node override);
   *  read by the capability resolver, invisible to ordinary handlers. */
  routing?: CapabilityRouting;
}

export type NodeHandler = (ctx: NodeHandlerContext) => Promise<NodeExecutionResult>;

export interface NodeExecPort {
  execute(ctx: NodeHandlerContext): Promise<NodeExecutionResult>;
  canExecute(type: string): boolean;
}

// ---------------------------------------------------------------------------
// Status helpers (mirror Helix's executeNode classification) so the engine and
// handlers agree on what a status means without re-deriving it everywhere.
// ---------------------------------------------------------------------------

export const NODE_STATUS = {
  ok: 200,
  unimplemented: 501,
  failed: 500,
} as const;

export const isCompleted = (status: number): boolean => status >= 200 && status < 300;
export const isUnimplemented = (status: number): boolean => status === 501;

/** Build the standard success envelope: `stateData:{status,data}` keyed by node. */
export function stateEnvelope(nodeId: string, type: string, data: unknown): NodeData {
  const stateId = `${nodeId}:${type}`;
  return { result: data, data, stateIds: [stateId], stateItems: [{ stateId, stateData: { status: 200, data } }] };
}

/** The referenceable output of a handler result (nodeData.data / .result). */
export function nodeOutput(result: NodeExecutionResult): unknown {
  return result.nodeData?.data ?? result.nodeData?.result ?? result.nodeData;
}
