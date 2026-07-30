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
 * The status reconciler: every minute, ask Temporal the TRUTH about runs the
 * store still thinks are running, and sync any that finished behind our back.
 * The store normally updates through the engine's own lifecycle activities -
 * but a hard terminate (mission control, Temporal UI, CLI) kills the workflow
 * WITHOUT those activities running, leaving a stale "running" row forever.
 * The reconciler closes that gap and emits the matching execution event so
 * connected UIs update live.
 */
import {
  ConditionFailedError,
  type EventSink,
  type ExecutionPort,
  type ExecutionStatusValue,
  type ItemRecord,
  type WorkflowEventName,
} from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';

export interface StatusReconcilerDeps {
  store: WorkflowStore;
  executions: ExecutionPort;
  events?: EventSink;
  tenantId: string;
  log?: (message: string) => void;
}

const EVENT_BY_STATUS: Partial<Record<ExecutionStatusValue, WorkflowEventName>> = {
  completed: 'workflow.execution.completed',
  failed: 'workflow.execution.failed',
  cancelled: 'workflow.execution.cancelled',
  terminated: 'workflow.execution.failed',
};

/**
 * Write the reconciled outcome, conditional on the row still being the one that
 * was listed. The listing happened before the queryStatus round trip and the
 * engine writes the real outcome from its own process, so an unconditional
 * write here is exactly how a failed run came to be displayed as completed:
 * Temporal reports a Metis-failed run as COMPLETED, because the workflow
 * function returns cleanly.
 *
 * Returns false when a fresher writer won.
 */
async function applyReconciledStatus(
  deps: StatusReconcilerDeps,
  executionId: string,
  truth: ExecutionStatusValue,
): Promise<boolean> {
  const changes: ItemRecord = {
    status: truth === 'terminated' ? 'terminated' : truth,
    endTime: new Date().toISOString(),
  };
  // Only a terminate has a reason WE know. Setting the field unconditionally
  // wrote undefined over whatever the engine had recorded, so every reconciled
  // failure lost the sentence that explained it.
  if (truth === 'terminated') {
    changes.failureReason = 'terminated outside the engine (reconciled from Temporal)';
  }
  try {
    await deps.store.updateExecutionMeta(deps.tenantId, executionId, changes, {
      ifMatches: { status: 'running' },
    });
    return true;
  } catch (error) {
    if (!(error instanceof ConditionFailedError)) throw error;
    // Retrying would only re-apply the same stale answer. Leave the row.
    deps.log?.(`skipped ${executionId}: the row moved on while Temporal was asked`);
    return false;
  }
}

/** One reconcile pass. Exported pure-ish so tests (and callers) can run it directly. */
export async function reconcileExecutionStatuses(
  deps: StatusReconcilerDeps,
): Promise<{ checked: number; fixed: number }> {
  const open = await deps.store.listExecutions(deps.tenantId, { status: 'running', limit: 100 });
  let fixed = 0;
  for (const row of open.items) {
    const executionId = String(row.executionId);
    let truth: ExecutionStatusValue;
    try {
      truth = await deps.executions.queryStatus(executionId);
    } catch {
      // Not answerable right now (Temporal down, or the run has fallen out of
      // retention). Leave the row alone; the next pass will retry.
      continue;
    }
    if (truth === 'running') continue;
    if (!(await applyReconciledStatus(deps, executionId, truth))) continue;
    deps.events?.emit({
      name: EVENT_BY_STATUS[truth] ?? 'workflow.execution.failed',
      tenantId: deps.tenantId,
      workflowId: typeof row.workflowId === 'string' ? row.workflowId : undefined,
      executionId,
      timestamp: new Date().toISOString(),
      payload: { reconciled: true, status: truth },
    });
    fixed += 1;
    deps.log?.(`reconciled ${executionId}: store said running, Temporal says ${truth}`);
  }
  return { checked: open.items.length, fixed };
}

/** The interval wrapper: one pass a minute, never overlapping, unref'd. */
export class StatusReconciler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: StatusReconcilerDeps) {}

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      reconcileExecutionStatuses(this.deps)
        .catch(() => undefined)
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
