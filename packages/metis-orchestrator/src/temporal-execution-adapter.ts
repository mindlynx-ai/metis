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
 * The Temporal ExecutionPort adapter: start, signal, cancel,
 * query and describe durable runs on the local Temporal dev server (or
 * any cluster) through the self-healing client holder. Cancellation is
 * the engine's cooperative helixCancelSignal, mirroring the origin,
 * so runs finalise their own state as cancelled.
 */
import { Client, Connection } from '@temporalio/client';
import type {
  ApiRunResult,
  ExecutionPort,
  ExecutionStatusValue,
  StartExecutionRequest,
  TemporalExecutionSummary,
} from '@mindlynx/metis-ports';
import { SelfHealing } from './self-heal.js';

export interface TemporalAdapterOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
  /** Inject an existing client (tests, embedded runtimes). */
  client?: Client;
}

const STATUS_MAP: Record<string, ExecutionStatusValue> = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TERMINATED: 'terminated',
  CONTINUED_AS_NEW: 'running',
  TIMED_OUT: 'failed',
};

export class TemporalExecutionAdapter implements ExecutionPort {
  private readonly holder: SelfHealing<Client>;
  private readonly taskQueue: string;
  private readonly namespace: string;

  constructor(options: TemporalAdapterOptions = {}) {
    this.taskQueue = options.taskQueue ?? 'metis-workflow-tasks';
    this.namespace = options.namespace ?? 'default';
    this.holder = new SelfHealing<Client>(async () => {
      if (options.client) return options.client;
      const connection = await Connection.connect({
        address: options.address ?? 'localhost:7233',
      });
      return new Client({ connection, namespace: options.namespace ?? 'default' });
    });
  }

  async start(
    request: StartExecutionRequest & Record<string, unknown>,
  ): Promise<{ executionId: string; runId?: string }> {
    const runId = await this.holder.withSelfHeal(async (client) => {
      const handle = await client.workflow.start(request.workflowType, {
        args: [request],
        workflowId: request.executionId,
        taskQueue: this.taskQueue,
      });
      return handle.firstExecutionRunId;
    });
    return { executionId: request.executionId, runId };
  }

  /**
   * Start a synchronous api workflow and await apiend's response, bounded by
   * waitMs. The workflow's own deadline still runs inside; this is the caller-
   * side ceiling so a stuck run cannot block the HTTP request forever.
   */
  async startApiAndWait(request: StartExecutionRequest, waitMs: number): Promise<ApiRunResult> {
    return this.holder.withSelfHeal(async (client) => {
      const handle = await client.workflow.start('helixApiWorkflow', {
        args: [request],
        workflowId: request.executionId,
        taskQueue: this.taskQueue,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), waitMs);
      });
      try {
        const raced = await Promise.race([handle.result(), timeout]);
        if ((raced as { timedOut?: boolean }).timedOut) {
          return { executionId: request.executionId, status: 'failed', timedOut: true };
        }
        const result = raced as { status: 'completed' | 'failed'; response?: unknown; statusCode?: number };
        return {
          executionId: request.executionId,
          status: result.status,
          response: result.response,
          statusCode: result.statusCode,
        };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** List executions straight from Temporal's visibility API (the UI view).
   *  `query.query` is a visibility filter (e.g. `ExecutionStatus="Running"`). */
  async list(query: { limit?: number; query?: string } = {}): Promise<TemporalExecutionSummary[]> {
    return this.holder.withSelfHeal(async (client) => {
      const limit = query.limit ?? 50;
      const out: TemporalExecutionSummary[] = [];
      for await (const execution of client.workflow.list({
        pageSize: Math.min(limit, 100),
        ...(query.query ? { query: query.query } : {}),
      })) {
        out.push({
          workflowId: execution.workflowId,
          runId: execution.runId,
          type: execution.type,
          status: STATUS_MAP[execution.status.name] ?? 'running',
          startTime: execution.startTime?.toISOString(),
          closeTime: execution.closeTime?.toISOString(),
          historyLength: execution.historyLength,
          taskQueue: execution.taskQueue,
        });
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  async signal(
    executionId: string,
    signalName: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.holder.withSelfHeal(async (client) => {
      await client.workflow.getHandle(executionId).signal(signalName, payload);
    });
  }

  async cancel(executionId: string, reason?: string): Promise<void> {
    await this.signal(executionId, 'helixCancelSignal', {
      cancelledBy: 'api',
      reason: reason ?? 'cancelled via the control plane',
    });
  }

  async queryStatus(executionId: string): Promise<ExecutionStatusValue> {
    return this.holder.withSelfHeal(async (client) => {
      const description = await client.workflow.getHandle(executionId).describe();
      return STATUS_MAP[description.status.name] ?? 'running';
    });
  }

  /** Hard stop: Temporal terminate (the workflow gets no say - use for stuck runs). */
  async terminate(executionId: string, reason?: string): Promise<void> {
    await this.holder.withSelfHeal(async (client) => {
      await client.workflow.getHandle(executionId).terminate(reason ?? 'terminated via mission control');
    });
  }

  /** Reset to the first workflow task via raw gRPC (no high-level helper exists). */
  async reset(executionId: string, reason?: string): Promise<{ runId: string }> {
    return this.holder.withSelfHeal(async (client) => {
      const description = await client.workflow.getHandle(executionId).describe();
      // protobufjs typings: the request wants a Long for the event id and the
      // service method is dual-overloaded; runtime accepts plain numbers.
      const response = (await client.workflowService.resetWorkflowExecution({
        namespace: this.namespace,
        workflowExecution: { workflowId: executionId, runId: description.runId },
        reason: reason ?? 'reset via mission control',
        // Reset to the first workflow task: re-run the whole definition.
        workflowTaskFinishEventId: 3,
        requestId: `reset-${executionId}-${Date.now()}`,
      } as never)) as { runId?: string };
      return { runId: response.runId ?? '' };
    });
  }

  /** Visibility counts per status - the mission-control headline row. */
  async countByStatus(): Promise<Record<string, number>> {
    return this.holder.withSelfHeal(async (client) => {
      const namespace = this.namespace;
      const statuses = ['Running', 'Completed', 'Failed', 'Canceled', 'Terminated', 'TimedOut'];
      const counts: Record<string, number> = {};
      await Promise.all(
        statuses.map(async (status) => {
          const response = (await client.workflowService.countWorkflowExecutions({
            namespace,
            query: `ExecutionStatus="${status}"`,
          } as never)) as { count?: number | { toNumber(): number } };
          const count = response.count;
          counts[status.toLowerCase()] =
            typeof count === 'object' && count !== null ? count.toNumber() : Number(count ?? 0);
        }),
      );
      return counts;
    });
  }

  /** Worker health: who is polling the task queue right now. */
  async taskQueueHealth(): Promise<{
    taskQueue: string;
    pollers: { identity: string; lastAccessTime?: string }[];
  }> {
    return this.holder.withSelfHeal(async (client) => {
      const response = (await client.workflowService.describeTaskQueue({
        namespace: this.namespace,
        taskQueue: { name: this.taskQueue },
        taskQueueType: 1, // WORKFLOW task queue
        includeTaskQueueStatus: true,
      } as never)) as {
        pollers?: { identity?: string; lastAccessTime?: { seconds?: number | { toNumber(): number } } }[];
        taskQueueStatus?: { backlogCountHint?: number | { toNumber(): number } };
        stats?: {
          approximateBacklogCount?: number | { toNumber(): number };
          approximateBacklogAge?: { seconds?: number | { toNumber(): number } };
        };
      };
      const pollers = (response.pollers ?? []).map((poller) => {
        const seconds = poller.lastAccessTime?.seconds;
        const epoch = typeof seconds === 'object' && seconds !== null ? seconds.toNumber() : Number(seconds ?? 0);
        return {
          identity: poller.identity ?? 'unknown',
          lastAccessTime: epoch > 0 ? new Date(epoch * 1000).toISOString() : undefined,
        };
      });
      const asNumber = (value: number | { toNumber(): number } | undefined): number =>
        typeof value === 'object' && value !== null ? value.toNumber() : Number(value ?? 0);
      // Backlog: prefer the newer stats shape, fall back to the status hint.
      const backlogCount = response.stats
        ? asNumber(response.stats.approximateBacklogCount)
        : asNumber(response.taskQueueStatus?.backlogCountHint);
      const backlogAgeSeconds = asNumber(response.stats?.approximateBacklogAge?.seconds);
      return { taskQueue: this.taskQueue, pollers, backlogCount, backlogAgeSeconds };
    });
  }

  async describe(executionId: string): Promise<Record<string, unknown>> {
    return this.holder.withSelfHeal(async (client) => {
      const description = await client.workflow.getHandle(executionId).describe();
      // Pending activities: the "why is my run stuck" facts (attempts, last
      // failure, state) straight from the raw describe response.
      const rawPending = (description.raw as {
        pendingActivities?: {
          activityType?: { name?: string };
          attempt?: number;
          maximumAttempts?: number;
          state?: unknown;
          lastFailure?: { message?: string };
        }[];
      }).pendingActivities;
      const pendingActivities = (rawPending ?? []).map((activity) => ({
        type: activity.activityType?.name,
        attempt: activity.attempt,
        maximumAttempts: activity.maximumAttempts,
        state: String(activity.state ?? ''),
        lastFailure: activity.lastFailure?.message,
      }));
      return {
        executionId,
        runId: description.runId,
        workflowType: description.type,
        status: description.status.name,
        startTime: description.startTime?.toISOString(),
        closeTime: description.closeTime?.toISOString(),
        taskQueue: description.taskQueue,
        historyLength: description.historyLength,
        parentExecutionId: description.parentExecution?.workflowId,
        pendingActivities,
      };
    });
  }
}
