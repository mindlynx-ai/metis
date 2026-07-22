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
 * The EventSink port: emit a workflow lifecycle
 * event, fire-and-forget. The open default writes structured lines to
 * stdout or a file; a sink must never throw into the engine.
 */
export const WORKFLOW_EVENT_NAMES = [
  'workflow.execution.started',
  'workflow.execution.completed',
  'workflow.execution.failed',
  'workflow.execution.cancelled',
  'workflow.node.started',
  'workflow.node.completed',
  'workflow.node.failed',
  'workflow.node.orphaned',
  'workflow.node.waiting',
  'workflow.node.unimplemented',
  'workflow.signal.received',
] as const;

export type WorkflowEventName = (typeof WORKFLOW_EVENT_NAMES)[number];

export interface WorkflowEvent {
  name: WorkflowEventName;
  tenantId: string;
  executionId?: string;
  workflowId?: string;
  nodeId?: string;
  /** ISO-8601, supplied by the caller so workflow code stays deterministic. */
  timestamp: string;
  payload?: Record<string, unknown>;
}

export interface EventSink {
  emit(event: WorkflowEvent): void;
}
