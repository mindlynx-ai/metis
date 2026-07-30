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
 * no-silent-cloud rule asserted from every angle, the degraded bind, and the
 * refusal that keeps a cloud bind off any data source but the cloud's own.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { CapabilityResolver, CLOUD_DATA_ENGINE } from '../adapters/capability-resolver.js';
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

describe('a cloud bind never silently swaps the data source', () => {
  const PG = { connectorId: 'conn_pg', engine: 'postgres', query: 'select * from orders' };
  const CLOUD = { connectorId: 'conn_warehouse', engine: CLOUD_DATA_ENGINE, query: 'select 1' };

  it.each([
    ['a connection chosen on the step', PG],
    ['a connection carried under the runtime alias', { connectionId: 'conn_pg', engine: 'postgres', query: 'x' }],
    [
      'a dataset handle from an earlier step, templated in as JSON text',
      { sourceRef: JSON.stringify({ kind: 'dataset', connectionId: 'conn_pg', engine: 'postgres', query: 'select 1' }) },
    ],
  ])('refuses the cloud bind for %s, and dispatches nothing', async (_name, config) => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }, config));
    expect(result.status).toBe(400);
    // The message names the connection and both ways out, so it is actionable
    // from the run log alone. Both have to be things the editor can actually
    // do: there is no warehouse connection to pick, so the advice is to clear
    // the one that is there, or to run the step here instead.
    expect(result.message).toContain('conn_pg');
    expect(result.message).toContain('Clear the connection');
    expect(result.message).toContain('Where it runs');
    expect(result.nodeData).toMatchObject({ code: 'cloud-connection' });
    expect(stub.requests['/v1/capabilities/data/invoke']).toBeUndefined();
  });

  it('allows the cloud bind when the step names the cloud warehouse', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }, CLOUD));
    expect(result.status).toBe(200);
    expect(result.binding).toBe('cloud');
  });

  it('allows the cloud bind when the engine was never recorded (a workflow saved before this)', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }, { connectorId: 'conn_legacy', query: 'select 1' }),
    );
    expect(result.status).toBe(200);
    expect(result.binding).toBe('cloud');
  });

  it('allows the cloud bind when the step names no connection at all', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }, { query: 'select 1' }),
    );
    expect(result.status).toBe(200);
    expect(result.binding).toBe('cloud');
  });

  it('leaves a LOCAL bind with its own connection completely alone', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(contextFor({ ...CONSENTED, nodeMode: 'local' }, PG));
    expect(result.status).toBe(200);
    expect(result.message).toBe('ran locally');
    expect(result.binding).toBeUndefined();
  });
});

describe('a cloud bind never quietly drops a filter it cannot honour', () => {
  // A handle the cloud itself produced from hand-written SQL: no connection to
  // name, so the foreign-connection rule has nothing to say about it.
  const RAW = { kind: 'dataset', connectionId: '', engine: CLOUD_DATA_ENGINE, query: 'select * from gold_orders' };
  const SPEC = { kind: 'dataset', connectionId: '', engine: CLOUD_DATA_ENGINE, table: 'gold_orders' };
  const FILTER = [{ column: 'status', operator: '=', value: 'paid' }];

  it.each([
    ['a where clause', { where: FILTER }],
    ['a cap', { limit: 10 }],
    ['an order', { orderBy: [{ column: 'total', direction: 'descending' }] }],
    ['a column list', { tables: [{ name: 'ignored', columns: [{ name: 'id' }] }] }],
  ])('refuses %s over a hand-written reference, and dispatches nothing', async (_name, narrowing) => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }, { sourceRef: RAW, ...narrowing }),
    );
    expect(result.status).toBe(400);
    // Actionable from the run log alone: it says which step to change and how.
    expect(result.message).toContain('hand-written query');
    expect(result.message).toContain('Build a query');
    expect(result.nodeData).toMatchObject({ code: 'cloud-reference-filter' });
    expect(stub.requests['/v1/capabilities/data/invoke']).toBeUndefined();
  });

  it('allows OPENING a hand-written reference: a flat query needs no wrapping', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }, { sourceRef: RAW }));
    expect(result.status).toBe(200);
    expect(result.binding).toBe('cloud');
  });

  it('allows filtering a spec reference, which composes flat instead of wrapping', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }, { sourceRef: SPEC, where: FILTER }),
    );
    expect(result.status).toBe(200);
    expect(result.binding).toBe('cloud');
  });

  it('reads a handle templated in as JSON text, exactly as the node does', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }, { sourceRef: JSON.stringify(RAW), where: FILTER }),
    );
    expect(result.status).toBe(400);
    expect(result.nodeData).toMatchObject({ code: 'cloud-reference-filter' });
  });

  it('leaves a LOCAL bind alone: wrapping the query works perfectly well here', async () => {
    const stub = await stubbed();
    const result = await resolverFor(stub).execute(
      contextFor({ ...CONSENTED, nodeMode: 'local' }, { sourceRef: RAW, where: FILTER }),
    );
    expect(result.status).toBe(200);
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

  it('a transport failure says the cloud was not reachable, because it was not', async () => {
    const result = await resolverFor({ url: 'http://127.0.0.1:1' }).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }),
    );
    expect(result.message).toContain('the cloud was not reachable');
  });
});

/**
 * The gateway's own refusal (a 400): the cloud answered, and its answer names
 * what about this step it cannot do. Degrading is right - the local backend can
 * filter a raw handle, and a step that can still run should still run - but the
 * degrade used to be reported as "the cloud was not reachable", which sent the
 * person to their network instead of to the step, and the real sentence survived
 * only in the gateway's logs.
 */
describe('a refused step degrades under the gateway own words', () => {
  const REFUSAL =
    'the dataset reference came from a hand-written query, so the cloud can open it but not '
    + 'filter it: filter it at the step that made the reference';

  it('a both-node runs locally, says the refusal, and stays visibly degraded', async () => {
    const stub = await stubbed({ refuseInvoke: REFUSAL });
    const result = await resolverFor(stub).execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }));
    expect(result.status).toBe(200);
    expect(result.binding).toBe('local-degraded');
    expect(result.nodeData?.data).toMatchObject({ ranIn: 'local' });
    expect(result.message).toContain(REFUSAL);
    // The bug this closes: the network took the blame for a config problem.
    expect(result.message).not.toContain('not reachable');
  });

  it('a cloud-only capability surfaces the refusal too, with nowhere to fall back to', async () => {
    const stub = await stubbed({ refuseInvoke: REFUSAL, entitled: ['cap.memory'] });
    const resolver = resolverFor(stub, {
      entryFor: () => ({ execution: 'cloud', entitlement: 'cap.memory' }),
    });
    const result = await resolver.execute(contextFor({ ...CONSENTED, nodeMode: 'cloud' }));
    expect(result.status).toBe(500);
    expect(result.binding).toBe('cloud');
    expect(result.message).toBe(REFUSAL);
  });
});

/**
 * The sentence a person actually reads. The degrade reason and the local
 * backend's own message were always joined with "; ", so a step that degraded
 * and then ran locally FINE ended "...filter it at the step that made the
 * reference; ok" - the handler's success message hung off the end of the
 * refusal, in the node chip's tooltip and the degraded banner, reading as a
 * truncation bug on the one sentence telling the person what to change.
 *
 * Both messages still matter when the fallback ALSO failed: there the combined
 * string is what travels as the failure's error.message, and dropping the local
 * reason would hide the second failure behind the first.
 */
describe('the degraded message a person reads', () => {
  const REFUSAL =
    'the cloud can open that reference but cannot filter it: filter it at the step that '
    + 'made the reference';
  /** What the real data node says on success (data-node.ts): 'ok'. */
  const okLocal: NodeExecPort = {
    canExecute: () => true,
    execute: async () => ({ status: 200, message: 'ok', nodeData: { data: { ranIn: 'local' } } }),
  };
  const failedLocal: NodeExecPort = {
    canExecute: () => true,
    execute: async () => ({
      status: 500,
      message: 'could not resolve credentials for connection "conn_1"',
    }),
  };

  it('a fallback that WORKED carries the gateway reason alone, with no "; ok" tail', async () => {
    const stub = await stubbed({ refuseInvoke: REFUSAL });
    const result = await resolverFor(stub, { local: okLocal }).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }),
    );
    expect(result.status).toBe(200);
    expect(result.binding).toBe('local-degraded'); // still visibly degraded
    expect(result.message).toBe(REFUSAL);
    expect(result.message).not.toMatch(/;\s*ok$/);
  });

  it('a fallback that ALSO FAILED keeps both, or the local failure is invisible', async () => {
    const stub = await stubbed({ refuseInvoke: REFUSAL });
    const result = await resolverFor(stub, { local: failedLocal }).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }),
    );
    expect(result.status).toBe(500);
    expect(result.binding).toBe('local-degraded');
    expect(result.message).toContain(REFUSAL);
    expect(result.message).toContain('could not resolve credentials for connection "conn_1"');
  });

  it('an unreachable cloud reads the same way: the reason, not the reason plus "ok"', async () => {
    const result = await resolverFor({ url: 'http://127.0.0.1:1' }, { local: okLocal }).execute(
      contextFor({ ...CONSENTED, nodeMode: 'cloud' }),
    );
    expect(result.binding).toBe('local-degraded');
    expect(result.message).toBe('the cloud was not reachable');
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
