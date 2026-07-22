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
 * Table-driven resolution tests (UPL-REQ-06): entitlement x workflow
 * toggle x consent x node override x threshold x gateway health, with the
 * no-silent-cloud rule asserted from every angle, plus the degraded bind.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { CapabilityResolver } from '../adapters/capability-resolver.js';
import { startHelixStub, type HelixStub } from '../adapters/helix-stub.js';
import { CapabilityGatewayClient, type CapabilityRouting } from '../uplift.js';
import type { NodeExecPort, NodeHandlerContext } from '../node-exec-port.js';

const localPort: NodeExecPort = {
  canExecute: (type) => type === 'data',
  execute: async (ctx) => ({
    status: 200,
    message: 'ran locally',
    nodeData: { data: { ranIn: 'local', node: ctx.nodeRef.id } },
  }),
};

const DATA_ENTRY = { execution: 'both', entitlement: 'cap.data' };

function contextFor(routing?: CapabilityRouting, config: Record<string, unknown> = {}): NodeHandlerContext {
  return {
    nodeRef: { id: 'n1', type: 'data', config },
    tenantId: 't1',
    executionId: 'exec_1',
    workflowId: 'wf_1',
    workflowState: { states: [] },
    routing,
  };
}

const stubs: HelixStub[] = [];
async function stubbed(options?: Parameters<typeof startHelixStub>[0]): Promise<HelixStub> {
  const stub = await startHelixStub(options);
  stubs.push(stub);
  return stub;
}
afterAll(async () => {
  await Promise.all(stubs.map((stub) => stub.close()));
});

function resolverFor(
  stub: HelixStub | { url: string } | undefined,
  overrides: Partial<ConstructorParameters<typeof CapabilityResolver>[0]> = {},
): CapabilityResolver {
  return new CapabilityResolver({
    local: localPort,
    entryFor: (type) => (type === 'data' ? DATA_ENTRY : undefined),
    entitlements: async () => new Set(['cap.data']),
    gateway: stub
      ? new CapabilityGatewayClient({
          baseUrl: stub.url,
          getBearer: async () => ('issueToken' in stub ? stub.issueToken() : 'bearer'),
          timeoutMs: 2_000,
        })
      : undefined,
    ...overrides,
  });
}

const CONSENTED = { enabled: true, consentAt: '2026-07-18T09:00:00Z' };

describe('resolution order (never cloud silently)', () => {
  const localBoundCases: { name: string; routing?: CapabilityRouting; entitled?: string[] }[] = [
    { name: 'no routing at all', routing: undefined },
    { name: 'enabled but no consent', routing: { enabled: true, nodeMode: 'cloud' } },
    { name: 'consent but workflow toggle off', routing: { consentAt: 'now', nodeMode: 'cloud' } },
    { name: 'enabled + consent but no node choice', routing: { ...CONSENTED } },
    { name: 'node override says local', routing: { ...CONSENTED, nodeMode: 'local' } },
    { name: 'auto without a threshold (no default, ever)', routing: { ...CONSENTED, nodeMode: 'auto' } },
    {
      name: 'auto with threshold not crossed',
      routing: { ...CONSENTED, nodeMode: 'auto', thresholdBytes: 10_000 },
    },
    {
      name: 'not entitled even with everything chosen',
      routing: { ...CONSENTED, nodeMode: 'cloud' },
      entitled: [],
    },
  ];

  it.each(localBoundCases)('binds LOCAL: $name', async ({ routing, entitled }) => {
    const stub = await stubbed();
    const resolver = resolverFor(stub, entitled ? { entitlements: async () => new Set(entitled) } : {});
    const result = await resolver.execute(contextFor(routing));
    expect(result.message).toBe('ran locally');
    expect(result.binding).toBeUndefined();
    expect(stub.requests['/v1/capabilities/data/invoke']).toBeUndefined();
  });

  it('binds CLOUD on explicit choice with consent and entitlement', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }, { sql: 'select 1' }),
    );
    expect(result.status).toBe(200);
    expect(result.binding).toBe('cloud');
    expect(result.nodeData?.data).toMatchObject({ cloud: true, capability: 'data' });
  });

  it('binds CLOUD when auto and the threshold is crossed', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'auto', thresholdBytes: 64 }, { blob: 'x'.repeat(200) }),
    );
    expect(result.binding).toBe('cloud');
  });

  it('kill switch: no gateway configured means local, whatever is chosen', async () => {
    const resolver = resolverFor(undefined);
    const result = await resolver.execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }));
    expect(result.message).toBe('ran locally');
    expect(result.binding).toBeUndefined();
  });
});

describe('degraded bind (UPL-REQ-10)', () => {
  it.each([
    ['gateway unreachable', async () => ({ url: 'http://127.0.0.1:1' })],
    ['contract mismatch', async () => stubbed({ contractVersion: '2' })],
    ['server-side unentitled (lapsed plan)', async () => stubbed({ entitled: [] })],
  ])('%s: a both-node runs locally and says so', async (_name, makeStub) => {
    const resolver = resolverFor(await makeStub());
    const result = await resolver.execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }));
    expect(result.status).toBe(200);
    expect(result.binding).toBe('local-degraded');
    expect(result.nodeData?.data).toMatchObject({ ranIn: 'local' });
  });

  it('a FAILED cloud job is a failure, not a degrade (the job ran)', async () => {
    const stub = await stubbed({ failJobs: true });
    const result = await resolverFor(stub).execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }));
    expect(result.status).toBe(500);
    expect(result.binding).toBe('cloud');
  });
});

describe('canExecute', () => {
  it('covers local handlers, cloud/both entries, and nothing else', () => {
    const resolver = new CapabilityResolver({
      local: localPort,
      entryFor: (type) =>
        type === 'cortex.recall' ? { execution: 'cloud', entitlement: 'cap.memory' } : undefined,
      entitlements: async () => new Set(),
    });
    expect(resolver.canExecute('data')).toBe(true); // local handler
    expect(resolver.canExecute('cortex.recall')).toBe(true); // cloud-only entry
    expect(resolver.canExecute('nonsense')).toBe(false);
  });
});
