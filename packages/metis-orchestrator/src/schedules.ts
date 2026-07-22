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
 * Schedule ingress: native Temporal Schedules, as in the
 * origin scheduleService, with deterministic ids sch_{tenantId}_{workflowId}.
 * The schedule action starts helixWorkflow with the published
 * definition resolved at creation time.
 */
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import type { WorkflowDefinition } from '@mindlynx/metis-engine';
import { SelfHealing } from './self-heal.js';

export interface ScheduleServiceOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
  client?: Client;
}

export const scheduleIdFor = (tenantId: string, workflowId: string): string =>
  `sch_${tenantId}_${workflowId}`;

export class ScheduleService {
  private readonly holder: SelfHealing<Client>;
  private readonly taskQueue: string;

  constructor(
    private readonly store: WorkflowStore,
    options: ScheduleServiceOptions = {},
  ) {
    this.taskQueue = options.taskQueue ?? 'metis-workflow-tasks';
    this.holder = new SelfHealing<Client>(async () => {
      if (options.client) return options.client;
      const connection = await Connection.connect({
        address: options.address ?? 'localhost:7233',
      });
      return new Client({ connection, namespace: options.namespace ?? 'default' });
    });
  }

  async create(tenantId: string, workflowId: string, cron: string): Promise<{ scheduleId: string }> {
    const published = await this.store.getLatestPublished(tenantId, workflowId);
    if (!published) {
      throw new Error(`workflow "${workflowId}" has no published version`);
    }
    const scheduleId = scheduleIdFor(tenantId, workflowId);
    const definition = published.definition as unknown as WorkflowDefinition;
    await this.holder.withSelfHeal(async (client) => {
      await client.schedule.create({
        scheduleId,
        spec: { cronExpressions: [cron] },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        action: {
          type: 'startWorkflow',
          workflowType: 'helixWorkflow',
          taskQueue: this.taskQueue,
          workflowId: `exec_${scheduleId}`,
          args: [
            {
              tenantId,
              workflowId,
              executionId: `exec_${scheduleId}`,
              definition,
              input: { scheduled: true, cron },
            },
          ],
        },
      });
    });
    return { scheduleId };
  }

  async runNow(tenantId: string, workflowId: string): Promise<void> {
    await this.holder.withSelfHeal(async (client) => {
      await client.schedule.getHandle(scheduleIdFor(tenantId, workflowId)).trigger();
    });
  }

  async remove(tenantId: string, workflowId: string): Promise<void> {
    await this.holder.withSelfHeal(async (client) => {
      await client.schedule.getHandle(scheduleIdFor(tenantId, workflowId)).delete();
    });
  }

  async list(tenantId: string): Promise<{ scheduleId: string }[]> {
    return this.holder.withSelfHeal(async (client) => {
      const out: { scheduleId: string }[] = [];
      for await (const summary of client.schedule.list()) {
        if (summary.scheduleId.startsWith(`sch_${tenantId}_`)) {
          out.push({ scheduleId: summary.scheduleId });
        }
      }
      return out;
    });
  }

  /** Pause a schedule (it stays defined; firing stops until unpaused). */
  async pause(tenantId: string, workflowId: string, note?: string): Promise<void> {
    await this.holder.withSelfHeal(async (client) => {
      await client.schedule
        .getHandle(scheduleIdFor(tenantId, workflowId))
        .pause(note ?? 'paused via mission control');
    });
  }

  /** Resume a paused schedule. */
  async unpause(tenantId: string, workflowId: string, note?: string): Promise<void> {
    await this.holder.withSelfHeal(async (client) => {
      await client.schedule
        .getHandle(scheduleIdFor(tenantId, workflowId))
        .unpause(note ?? 'resumed via mission control');
    });
  }

  /** The mission-control view: every schedule with its state and next firing. */
  async describeAll(tenantId: string): Promise<
    {
      scheduleId: string;
      workflowId: string;
      paused: boolean;
      cron?: string;
      nextRun?: string;
      nextRuns?: string[];
    }[]
  > {
    return this.holder.withSelfHeal(async (client) => {
      const prefix = `sch_${tenantId}_`;
      const out: {
        scheduleId: string;
        workflowId: string;
        paused: boolean;
        cron?: string;
        nextRun?: string;
        nextRuns?: string[];
      }[] = [];
      for await (const summary of client.schedule.list()) {
        if (!summary.scheduleId.startsWith(prefix)) continue;
        // Defensive reads: the summary carries state/info in recent SDKs; fall
        // back to a describe() only if the summary lacks them.
        type SpecShape = { calendars?: { comment?: string }[]; cronExpressions?: string[] };
        type ActionShape = { args?: { input?: { cron?: string } }[] };
        // The SDK converts cronExpressions into structured calendars at
        // create, so a describe does NOT return the original string. Our
        // create() embeds the cron in the action input - read it back from
        // there (spec fields kept as first choice for any hand-made schedule).
        const cronOf = (spec?: SpecShape, action?: ActionShape): string | undefined =>
          spec?.cronExpressions?.[0] ||
          spec?.calendars?.[0]?.comment ||
          action?.args?.[0]?.input?.cron ||
          undefined;
        const raw = summary as unknown as {
          state?: { paused?: boolean };
          info?: { nextActionTimes?: Date[] };
          spec?: SpecShape;
          action?: ActionShape;
        };
        let paused = raw.state?.paused;
        let nextTimes = raw.info?.nextActionTimes;
        let cron = cronOf(raw.spec, raw.action);
        if (paused === undefined || cron === undefined) {
          const description = (await client.schedule.getHandle(summary.scheduleId).describe()) as unknown as {
            state?: { paused?: boolean };
            info?: { nextActionTimes?: Date[] };
            spec?: SpecShape;
            action?: ActionShape;
          };
          paused = paused ?? description.state?.paused ?? false;
          nextTimes = nextTimes ?? description.info?.nextActionTimes;
          cron = cron ?? cronOf(description.spec, description.action);
        }
        const nextRuns = (nextTimes ?? [])
          .filter((time): time is Date => time instanceof Date)
          .map((time) => time.toISOString());
        out.push({
          scheduleId: summary.scheduleId,
          workflowId: summary.scheduleId.slice(prefix.length),
          paused: paused ?? false,
          cron: typeof cron === 'string' ? cron : undefined,
          nextRun: nextRuns[0],
          nextRuns,
        });
      }
      return out;
    });
  }
}
