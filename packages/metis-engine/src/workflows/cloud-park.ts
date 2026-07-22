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
 * The durable wait on an accepted cloud job (workflow-side, deterministic).
 * The poll runs under its own 24-hour, heartbeated activity budget: a dead
 * worker is detected in minutes and Temporal retries the poll on another -
 * the jobId rides workflow history, so restart survival is free. The run's
 * cancel signal races the poll and propagates a best-effort job cancel.
 */
import { condition, proxyActivities } from '@temporalio/workflow';
import type { EngineActivities, ExecuteNodeResult, HelixWorkflowInput } from '../types.js';

const waitActivities = proxyActivities<Pick<EngineActivities, 'markNodeWaiting'>>({
  startToCloseTimeout: '2 minutes',
});

const cloudActivities = proxyActivities<Pick<EngineActivities, 'pollCloudJob' | 'cancelCloudJob'>>({
  startToCloseTimeout: '24 hours',
  heartbeatTimeout: '2 minutes',
});

/** Park on the job until terminal or the run is cancelled. */
export async function awaitCloudJob(
  input: Pick<HelixWorkflowInput, 'tenantId' | 'workflowId' | 'executionId'>,
  node: { id: string; type: string },
  jobId: string,
  sequence: number,
  isCancelled: () => boolean,
): Promise<ExecuteNodeResult | 'cancelled'> {
  const ids = {
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    executionId: input.executionId,
  };
  await waitActivities.markNodeWaiting({
    ...ids,
    nodeId: node.id,
    nodeType: node.type,
    signalType: `cloud-job:${jobId}`,
    sequence,
  });
  const winner = await Promise.race([
    cloudActivities.pollCloudJob({ ...ids, nodeId: node.id, nodeType: node.type, jobId, sequence }),
    condition(() => isCancelled()).then(() => 'cancelled' as const),
  ]);
  if (winner === 'cancelled') {
    await cloudActivities.cancelCloudJob({ jobId }).catch(() => undefined);
    return 'cancelled';
  }
  return winner;
}
