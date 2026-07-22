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
 * The Metis Temporal worker factory. Encapsulates the
 * workflow bundle path and activity wiring so runtimes (the CLI, the
 * compose image) create a worker without knowing the engine's internal
 * file layout.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, type EnginePorts } from './activities/create-activities.js';

export const METIS_TASK_QUEUE = 'metis-workflow-tasks';

export interface WorkerOptions extends EnginePorts {
  address?: string;
  taskQueue?: string;
  namespace?: string;
}

export function workflowsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, 'workflows', 'index.js');
  const source = join(here, 'workflows', 'index.ts');
  return existsSync(built) ? built : source;
}

/** Create and return a started-on-demand Metis worker. */
export async function createMetisWorker(options: WorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({
    address: options.address ?? 'localhost:7233',
  });
  return Worker.create({
    connection,
    namespace: options.namespace ?? 'default',
    taskQueue: options.taskQueue ?? METIS_TASK_QUEUE,
    workflowsPath: workflowsPath(),
    activities: createActivities({
      store: options.store,
      events: options.events,
      nodes: options.nodes,
      credentials: options.credentials,
      gateway: options.gateway,
    }),
  });
}
