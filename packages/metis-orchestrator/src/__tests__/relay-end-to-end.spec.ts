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
 * The whole cap.webhook loop, with nothing faked between the ends: a real
 * provider request to the relay stub's PUBLIC address, the real relay client,
 * the real poller, and the real `handleWebhook` - which starts a real run.
 *
 * This is the test that matters. The pieces each pass on their own; what has to
 * be true is that a delivery arriving through the cloud is indistinguishable
 * from one that arrived on `/hooks/<id>` locally, including the provider's own
 * signature still verifying on this side.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionPort, StartExecutionRequest } from '@mindlynx/metis-ports';
import { startHelixStub, WebhookRelayClient, type HelixStub } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { TriggerService, registerTriggerTable } from '../triggers.js';
import { handleWebhook, type WebhookEnvelope } from '../webhook-ingress.js';
import { RelayPoller } from '../relay-poller.js';

class FakeExecutions implements ExecutionPort {
  started: (StartExecutionRequest & Record<string, unknown>)[] = [];
  async start(request: StartExecutionRequest & Record<string, unknown>) {
    this.started.push(request);
    return { executionId: request.executionId };
  }
  async signal() {}
  async cancel() {}
  async queryStatus() {
    return 'running' as const;
  }
  async describe() {
    return {};
  }
}

let stub: HelixStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'metis-relay-'));
  const gateway = new DataGateway(new SqliteAdapter(join(dir, 'relay.db')));
  registerWorkflowTables(gateway);
  registerTriggerTable(gateway);
  const store = new WorkflowStore(gateway);
  const triggers = new TriggerService(gateway, 't1');
  const executions = new FakeExecutions();
  await store.putWorkflowVersion({
    tenantId: 't1',
    workflowId: 'wf',
    version: 1,
    changeset: 0,
    status: 'published',
    name: 'wf',
    type: 'workflow',
    definition: { nodes: [{ id: 'n', type: 'code', config: { code: 'return {}' } }], edges: [] },
  });

  stub = await startHelixStub({ entitled: ['cap.webhook'] });
  const token = stub.issueToken();
  const relay = new WebhookRelayClient({ baseUrl: stub.url, getBearer: () => Promise.resolve(token) });

  let executionCounter = 0;
  const poller = new RelayPoller({
    triggers,
    relay: () => relay,
    deliver: (args) =>
      handleWebhook(
        {
          triggers,
          store,
          executions,
          tenantId: 't1',
          newExecutionId: () => {
            executionCounter += 1;
            return `exec_${executionCounter}`;
          },
          now: () => '2026-08-25T12:00:00.000Z',
        },
        args,
      ),
  });
  return { triggers, executions, poller, relay };
}

const providerPost = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('a webhook delivered through the cloud relay', () => {
  it('starts the bound workflow, with the provider signature verified HERE', async () => {
    const { triggers, executions, poller } = await harness();
    // A GitHub-signed trigger: the provider's secret lives on this instance and
    // the relay never sees it.
    const trigger = await triggers.create({
      kind: 'webhook',
      workflowId: 'wf',
      connectorId: 'github',
      event: 'push',
      verification: 'github',
      secret: 'the-providers-secret',
    });

    // Claim the address (what a real poll pass does first).
    const first = await poller.pollOnce();
    expect(first.claimed).toBe(1);
    const endpoint = poller.endpointFor(trigger.triggerId);
    expect(endpoint?.url).toContain('/relay/');

    // A provider posts to the PUBLIC address. It is answered at once.
    const body = '{"ref":"refs/heads/main"}';
    const signature = `sha256=${createHmac('sha256', 'the-providers-secret').update(body).digest('hex')}`;
    const answered = await providerPost(endpoint!.url, body, {
      'x-hub-signature-256': signature,
      'x-github-event': 'push',
    });
    expect(answered.status).toBe(202);
    expect(executions.started).toHaveLength(0);

    // The instance collects it and the run starts.
    const second = await poller.pollOnce();
    expect(second.delivered).toBe(1);
    expect(executions.started).toHaveLength(1);
    const envelope = executions.started[0].input as unknown as WebhookEnvelope;
    expect(envelope.connectorId).toBe('github');
    expect(envelope.event).toBe('push');
    expect((envelope.body as { ref: string }).ref).toBe('refs/heads/main');
  });

  it('refuses a delivery whose PROVIDER signature is wrong, even though the relay is genuine', async () => {
    // The relay signed it correctly - it really did come from our cloud - but
    // the payload is not from the provider it claims. Both signatures matter,
    // and neither substitutes for the other.
    const { triggers, executions, poller } = await harness();
    await triggers.create({
      kind: 'webhook',
      workflowId: 'wf',
      verification: 'github',
      secret: 'the-providers-secret',
    });
    await poller.pollOnce();
    const endpoint = poller.endpointFor((await triggers.list())[0].triggerId);
    await providerPost(endpoint!.url, '{"ref":"nope"}', { 'x-hub-signature-256': 'sha256=forged' });

    const outcome = await poller.pollOnce();
    expect(outcome.delivered).toBe(0);
    expect(outcome.refused).toBe(1);
    expect(executions.started).toHaveLength(0);
  });

  it('collects each delivery once, across several polls', async () => {
    const { triggers, executions, poller } = await harness();
    const trigger = await triggers.create({ kind: 'webhook', workflowId: 'wf', verification: 'none' });
    await poller.pollOnce();
    const endpoint = poller.endpointFor(trigger.triggerId);

    await providerPost(endpoint!.url, '{"n":1}');
    await providerPost(endpoint!.url, '{"n":2}');
    expect((await poller.pollOnce()).delivered).toBe(2);
    // Nothing new: a second pass must not replay what it already ran.
    expect((await poller.pollOnce()).delivered).toBe(0);
    await providerPost(endpoint!.url, '{"n":3}');
    expect((await poller.pollOnce()).delivered).toBe(1);
    expect(executions.started).toHaveLength(3);
  });

  it('stops taking deliveries once the trigger is deleted', async () => {
    const { triggers, poller } = await harness();
    const trigger = await triggers.create({ kind: 'webhook', workflowId: 'wf', verification: 'none' });
    await poller.pollOnce();
    const endpoint = poller.endpointFor(trigger.triggerId);

    await triggers.remove(trigger.triggerId);
    await poller.pollOnce();
    // The public address is released, so the provider's next call 404s rather
    // than queueing for an instance that is no longer listening.
    expect((await providerPost(endpoint!.url, '{}')).status).toBe(404);
  });
});
