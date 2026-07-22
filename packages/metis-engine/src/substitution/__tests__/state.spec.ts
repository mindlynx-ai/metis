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
import { describe, it, expect } from 'vitest';
import {
  findNodeConfigParams,
  replaceConfigStateData,
  type WorkflowStateItem,
} from '../state.js';

const NODE_A = 'node-aaaaaaaa-1111-4222-8333-444444444444';
const NODE_B = 'node-bbbbbbbb-1111-4222-8333-444444444444';
const SECRET_ID = 'cccccccc-1111-4222-8333-444444444444';

const stateWith = (states: WorkflowStateItem['states']): WorkflowStateItem => ({ states });

const run = (config: unknown, state: WorkflowStateItem): unknown =>
  replaceConfigStateData('exec1', 'tenant1', config, state);

describe('findNodeConfigParams reference regexes', () => {
  it('classifies the three families and never the unported ones', () => {
    const config = {
      a: `{{${NODE_A}.data.value}}`,
      b: NODE_B,
      c: `{{secrets.${SECRET_ID}}}`,
      d: '{{uuid()}}',
      e: '{{pathMapping.order_id}}',
      f: '{{headerMapping.x-request-id}}',
      g: '{{env.HELIX_CORE_URL}}',
    };
    const params = findNodeConfigParams(config);
    const byType = (type: string) => params.filter((p) => p.type === type).map((p) => p.value);
    expect(byType('node')).toEqual([`{{${NODE_A}.data.value}}`, `{{${NODE_B}}}`]);
    expect(byType('secret')).toEqual([`{{secrets.${SECRET_ID}}}`]);
    expect(byType('function')).toEqual(['{{uuid()}}']);
    // The unported pathMapping/headerMapping and env families are never
    // classified: their tokens pass through the engine literally.
    expect(params).toHaveLength(4);
  });

  it('returns no params for a resolved config', () => {
    expect(findNodeConfigParams({ url: 'https://example.test', n: 3 })).toEqual([]);
  });
});

describe('replaceConfigStateData', () => {
  it('resolves node references through a dot path, preserving types', async () => {
    const state = stateWith([
      {
        nodeId: NODE_A,
        stateId: 's1',
        stateData: { status: 200, data: { count: 7, label: 'ok', nested: { deep: true } } },
      },
    ]);
    const resolved = (await run(
      {
        text: `count is {{${NODE_A}.data.count}}`,
        whole: `{{${NODE_A}.data.nested}}`,
        label: `{{${NODE_A}.data.label}}`,
      },
      state,
    )) as Record<string, unknown>;
    expect(resolved.text).toBe('count is 7');
    expect(resolved.whole).toBe('{"deep":true}');
    expect(resolved.label).toBe('ok');
  });

  it('escapes backslash, double quote and newline in string interpolations', async () => {
    const state = stateWith([
      {
        nodeId: NODE_A,
        stateId: 's1',
        stateData: { status: 200, data: { tricky: 'a "quoted" \\ back\nslash' } },
      },
    ]);
    const resolved = (await run({ msg: `value: {{${NODE_A}.data.tricky}}` }, state)) as Record<
      string,
      unknown
    >;
    expect(resolved.msg).toBe('value: a "quoted" \\ back\nslash');
  });

  it('resolves a naked node path through the switch-node property special case', async () => {
    const state = stateWith([
      { nodeId: NODE_B, stateId: 's1', stateData: { status: 200, data: { label: 'chosen' } } },
    ]);
    const resolved = (await run(
      { property: `${NODE_B}.data.label`, operator: '===' },
      state,
    )) as Record<string, unknown>;
    expect(resolved.property).toBe('chosen');
    expect(resolved.operator).toBe('===');
  });

  it('leaves a reference literal when state data is not inline', async () => {
    const state = stateWith([{ nodeId: NODE_A, stateId: 's1' }]);
    const resolved = (await run(
      { v: `{{${NODE_A}.data.fetched}}` },
      state,
    )) as Record<string, unknown>;
    expect(resolved.v).toBe(`{{${NODE_A}.data.fetched}}`);
  });

  it('leaves secret tokens untouched for the CredentialPort boundary', async () => {
    const config = { auth: `Bearer {{secrets.${SECRET_ID}}}` };
    const resolved = (await run(config, stateWith([]))) as Record<string, unknown>;
    expect(resolved.auth).toBe(`Bearer {{secrets.${SECRET_ID}}}`);
  });

  it('resolves the six built-in functions', async () => {
    const resolved = (await run(
      {
        id: '{{uuid()}}',
        other: '{{uuid()}}',
        at: '{{now()}}',
        epoch: '{{time()}}',
        r: '{{random()}}',
        wf: '{{workflowId()}}',
        tenant: '{{tenantId()}}',
      },
      stateWith([]),
    )) as Record<string, string>;
    expect(resolved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(resolved.other).not.toBe(resolved.id);
    expect(Number.isNaN(Date.parse(resolved.at))).toBe(false);
    expect(Number(resolved.epoch)).toBeGreaterThan(0);
    expect(Number(resolved.r)).toBeGreaterThanOrEqual(0);
    expect(resolved.wf).toBe('exec1');
    expect(resolved.tenant).toBe('tenant1');
  });

  it('leaves the unported pathMapping and headerMapping tokens literal', async () => {
    const resolved = (await run(
      { url: 'https://api.test/orders/{{pathMapping.order_id}}', rid: '{{headerMapping.x-request-id}}' },
      stateWith([]),
    )) as Record<string, unknown>;
    expect(resolved.url).toBe('https://api.test/orders/{{pathMapping.order_id}}');
    expect(resolved.rid).toBe('{{headerMapping.x-request-id}}');
  });

  it('does not resolve the env family', async () => {
    process.env.METIS_TEST_LEAK = 'leaky';
    const resolved = (await run({ v: '{{env.METIS_TEST_LEAK}}' }, stateWith([]))) as Record<
      string,
      unknown
    >;
    expect(resolved.v).toBe('{{env.METIS_TEST_LEAK}}');
    delete process.env.METIS_TEST_LEAK;
  });

  it('returns the config untouched when there is nothing to resolve', async () => {
    const config = { plain: true, n: 2 };
    expect(await run(config, stateWith([]))).toBe(config);
  });
});

describe('picker reference contract (the two trigger seeding shapes)', () => {
  // The variable picker (editor) emits the canonical `{{node-<uuid>.data.<key>}}`
  // form. A trigger node is seeded {status:200, data: <seed>} where <seed> is:
  //   - apiconfig:      the request body directly        -> data.<key>
  //   - webhookconfig:  the envelope {..., body:{...}}   -> data.body.<key>
  // Both must resolve, and the legacy naked `{{node-<uuid>.<key>}}` form (still
  // emitted by the io-panels chips) must keep working during the migration.
  it('resolves an apiconfig-shaped seed: request body lands at data.<key>', async () => {
    const state = stateWith([
      {
        nodeId: NODE_A,
        stateId: 'trigger',
        stateData: { status: 200, data: { firstName: 'Ada', order: 42 } },
      },
    ]);
    const resolved = (await run(
      {
        canonical: `Hello {{${NODE_A}.data.firstName}}`,
        legacy: `Hello {{${NODE_A}.firstName}}`,
        number: `{{${NODE_A}.data.order}}`,
      },
      state,
    )) as Record<string, unknown>;
    expect(resolved.canonical).toBe('Hello Ada');
    expect(resolved.legacy).toBe('Hello Ada');
    expect(resolved.number).toBe('42');
  });

  it('resolves a webhookconfig-shaped seed: request body nests under data.body.<key>', async () => {
    const envelope = {
      triggerId: 'trg-1',
      connectorId: 'github',
      body: { firstName: 'Grace', email: 'grace@example.test' },
    };
    const state = stateWith([
      { nodeId: NODE_A, stateId: 'trigger', stateData: { status: 200, data: envelope } },
    ]);
    const resolved = (await run(
      {
        greeting: `Hi {{${NODE_A}.data.body.firstName}}`,
        to: `{{${NODE_A}.data.body.email}}`,
        connector: `{{${NODE_A}.data.connectorId}}`,
        legacy: `Hi {{${NODE_A}.body.firstName}}`,
      },
      state,
    )) as Record<string, unknown>;
    expect(resolved.greeting).toBe('Hi Grace');
    expect(resolved.to).toBe('grace@example.test');
    expect(resolved.connector).toBe('github');
    expect(resolved.legacy).toBe('Hi Grace');
  });

  it('leaves a reference to an unseeded node literal (never throws, never blanks)', async () => {
    const state = stateWith([
      { nodeId: NODE_A, stateId: 'trigger', stateData: { status: 200, data: { firstName: 'Ada' } } },
    ]);
    const resolved = (await run(
      { known: `{{${NODE_A}.data.firstName}}`, unknown: `{{${NODE_B}.data.missing}}` },
      state,
    )) as Record<string, unknown>;
    expect(resolved.known).toBe('Ada');
    expect(resolved.unknown).toBe(`{{${NODE_B}.data.missing}}`);
  });
});
