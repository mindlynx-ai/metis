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
 * The floor under node output size.
 *
 * A node's output is returned from the activity, so it is serialised into
 * workflow history, and the whole state array is then the input to every later
 * dispatch. The data node caps its read at 256 KB and the object store and the
 * loop cap too, but the caps were per-handler: the http node read a response of
 * any size and the code node returned whatever the isolate produced, and a
 * multi-megabyte one wedged the run on Temporal's payload limit - the very
 * thing the object-store node caps to avoid.
 *
 * The cap belongs at the activity boundary, which is where the payload is
 * serialised and the one place every handler's output passes through. It fails
 * the node rather than truncating: a truncated output is substituted into the
 * next node's config and sent to whatever is downstream, and half a record
 * posted to a live system is worse than a run that stopped and said why.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapturingEventSink, FakeCredentialPort, NodeHandlerRegistry } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import { NODE_OUTPUT_BYTES } from '../types.js';

const NODE = 'node-70aaaaaa-1111-4222-8333-444444444444';

/** An activity surface whose one handler returns a body of the asked-for size. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'metis-output-cap-'));
  const gateway = new DataGateway(new SqliteAdapter(join(dir, 'output-cap.db')));
  registerWorkflowTables(gateway);
  const store = new WorkflowStore(gateway);
  const nodes = new NodeHandlerRegistry();
  nodes.registerNodeHandler('bulk', (ctx) =>
    Promise.resolve({
      status: 200,
      message: 'ok',
      nodeData: { data: { body: 'x'.repeat(Number(ctx.nodeRef.config.bytes ?? 0)) } },
    }),
  );
  return { activities: createActivities({ store, events: new CapturingEventSink(), nodes, credentials: new FakeCredentialPort() }), store };
}

let counter = 0;
const execute = (bytes: number) => {
  counter += 1;
  const { activities, store } = harness();
  const executionId = `exec-output-cap-${counter}`;
  return {
    store,
    executionId,
    result: activities.executeNode({
      tenantId: 't1',
      workflowId: 'wf-output-cap',
      executionId,
      node: { id: NODE, type: 'bulk', config: { bytes } },
      states: [],
      sequence: 1,
    }),
  };
};

describe('node output is capped where the payload is serialised', () => {
  it('passes an ordinary output straight through', async () => {
    const { result } = execute(1024);
    const outcome = await result;
    expect(outcome.outcome).toBe('completed');
    expect((outcome.output as { body: string }).body).toHaveLength(1024);
  });

  it('fails the node when its output is over the ceiling, naming the size', async () => {
    const { result } = execute(NODE_OUTPUT_BYTES + 1024);
    const outcome = await result;
    expect(outcome.outcome).toBe('failed');
    expect(outcome.error?.message).toMatch(new RegExp(String(NODE_OUTPUT_BYTES)));
    // Failing loudly is only worth it if the output does NOT ride along.
    expect(outcome.output).toBeUndefined();
  });

  it('writes the breach to the run log so the canvas can say which node it was', async () => {
    const { result, store, executionId } = execute(NODE_OUTPUT_BYTES + 1024);
    await result;
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId,
      workflowId: 'wf-output-cap',
      status: 'running',
      startTime: new Date().toISOString(),
    });
    const execution = await store.getExecution('t1', executionId);
    const terminal = (execution?.logs ?? []).find((log) => log.nodeId === NODE && log.sequence % 10 === 2);
    expect(terminal?.event).toBe('workflow.node.failed');
    expect(terminal?.output).toBeUndefined();
  });
});
