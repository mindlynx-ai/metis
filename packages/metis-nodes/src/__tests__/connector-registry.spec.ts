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
import { DataGateway, MemoryAdapter } from '@mindlynx/metis-data-gateway';
import {
  ConnectorRegistry,
  registerConnectorTable,
  validateConnectorRecord,
  connectorTier,
  findOperation,
  type ConnectorRecord,
} from '../connector-registry.js';

const wired: ConnectorRecord = {
  connectorId: 'slack',
  name: 'Slack',
  baseUrl: 'https://slack.com/api',
  authScheme: 'bearer',
  tier: 'open',
  category: 'communication',
  priority: 'P1',
  operations: [
    {
      name: 'postMessage',
      method: 'POST',
      pathTemplate: '/chat.postMessage',
      wireStatus: 'verified',
    },
    {
      name: 'getConversation',
      method: 'GET',
      pathTemplate: '/conversations.info',
      wireStatus: 'verified',
    },
  ],
  events: [{ name: 'message', kind: 'webhook' }],
  provenance: { source: 'n8n', licence: 'sustainable-use (inspiration)' },
};

const registry = () => {
  const gateway = new DataGateway(new MemoryAdapter());
  registerConnectorTable(gateway);
  return new ConnectorRegistry(gateway);
};

describe('connector registry - operation/event/tier model', () => {
  it('round-trips operations, events, tier and provenance through the table', async () => {
    const reg = registry();
    await reg.register('t1', wired);
    const back = await reg.get('t1', 'slack');
    expect(back).toBeDefined();
    expect(back?.operations).toHaveLength(2);
    expect(findOperation(back as ConnectorRecord, 'postMessage')?.method).toBe('POST');
    expect(back?.events?.[0]).toEqual({ name: 'message', kind: 'webhook' });
    expect(back?.tier).toBe('open');
    expect(back?.priority).toBe('P1');
    expect(back?.provenance?.source).toBe('n8n');
  });

  it('lists records for a tenant', async () => {
    const reg = registry();
    await reg.register('t1', wired);
    await reg.register('t1', { ...wired, connectorId: 'notion', name: 'Notion', tier: 'premium' });
    const all = await reg.list('t1');
    expect(all.map((r) => r.connectorId).sort()).toEqual(['notion', 'slack']);
  });

  it('defaults a record without an explicit tier to open', async () => {
    const reg = registry();
    await reg.register('t1', {
      connectorId: 'plain',
      name: 'Plain',
      baseUrl: 'https://example.com',
      authScheme: 'none',
    });
    const back = await reg.get('t1', 'plain');
    expect(connectorTier(back as ConnectorRecord)).toBe('open');
    expect(back?.tier).toBe('open');
  });

  it('rejects an invalid operation on register', async () => {
    const reg = registry();
    await expect(
      reg.register('t1', {
        ...wired,
        operations: [{ name: '', method: 'FETCH' as never, pathTemplate: 'http://x', wireStatus: 'bogus' as never }],
      }),
    ).rejects.toThrow(/invalid connector record/);
  });

  it('flags duplicate operations and bad base URLs', () => {
    const problems = validateConnectorRecord({
      connectorId: 'dup',
      name: 'Dup',
      baseUrl: 'ftp://nope',
      authScheme: 'none',
      operations: [
        { name: 'a', method: 'GET', pathTemplate: '/a', wireStatus: 'verified' },
        { name: 'a', method: 'GET', pathTemplate: '/a', wireStatus: 'verified' },
      ],
    });
    expect(problems.some((p) => /baseUrl must be http/.test(p))).toBe(true);
    expect(problems.some((p) => /duplicate operation "a"/.test(p))).toBe(true);
  });

  it('accepts a clean record with no problems', () => {
    expect(validateConnectorRecord(wired)).toEqual([]);
  });
});
