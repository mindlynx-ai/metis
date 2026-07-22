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
 * The ExecutionPort: start, signal, cancel and query a
 * durable run. Temporal is deliberately not abstracted away; this port
 * exists so deployments can point at a different Temporal cluster, not
 * at a different engine.
 */
export type WorkflowType = 'helixWorkflow' | 'helixApiWorkflow';

export type ExecutionStatusValue = 'running' | 'completed' | 'failed' | 'cancelled' | 'terminated';

export interface StartExecutionRequest {
  tenantId: string;
  workflowId: string;
  executionId: string;
  workflowType: WorkflowType;
  input?: Record<string, unknown>;
}

/**
 * One workflow execution as Temporal's own visibility API reports it: the
 * view the Temporal Web UI shows, so a history list needs no Temporal UI.
 * The Temporal workflowId is the Metis executionId.
 */
export interface TemporalExecutionSummary {
  workflowId: string;
  runId: string;
  type: string;
  status: ExecutionStatusValue;
  startTime?: string;
  closeTime?: string;
  historyLength?: number;
  taskQueue?: string;
}

/** The result of a synchronous api-workflow run: apiend's body + status. */
export interface ApiRunResult {
  executionId: string;
  status: 'completed' | 'failed';
  response?: unknown;
  statusCode?: number;
  /** True when the run did not finish within the wait budget. */
  timedOut?: boolean;
}

export interface ExecutionPort {
  start(request: StartExecutionRequest): Promise<{ executionId: string; runId?: string }>;
  /**
   * Start a synchronous api workflow (apiconfig -> ... -> apiend) and await its
   * response, bounded by waitMs. Optional: only Temporal-backed deployments and
   * the test fakes implement it.
   */
  startApiAndWait?(request: StartExecutionRequest, waitMs: number): Promise<ApiRunResult>;
  signal(executionId: string, signalName: string, payload?: Record<string, unknown>): Promise<void>;
  cancel(executionId: string, reason?: string): Promise<void>;
  queryStatus(executionId: string): Promise<ExecutionStatusValue>;
  describe(executionId: string): Promise<Record<string, unknown>>;
  /** List executions from Temporal's visibility API (the SDK/UI view).
   *  `query` is a Temporal visibility filter (e.g. `ExecutionStatus="Running"`). */
  list?(query?: { limit?: number; query?: string }): Promise<TemporalExecutionSummary[]>;
  /** Hard stop (Temporal terminate) - unlike cancel, the workflow gets no say. */
  terminate?(executionId: string, reason?: string): Promise<void>;
  /** Reset the execution to its first workflow task (re-run from the top). */
  reset?(executionId: string, reason?: string): Promise<{ runId: string }>;
  /** Visibility counts by execution status (mission control's headline row). */
  countByStatus?(): Promise<Record<string, number>>;
  /** Worker/queue health: the pollers currently polling the task queue,
   *  plus the approximate backlog (queued tasks predict stalls). */
  taskQueueHealth?(): Promise<{
    taskQueue: string;
    pollers: { identity: string; lastAccessTime?: string }[];
    backlogCount?: number;
    backlogAgeSeconds?: number;
  }>;
}
