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
import { FakeDataStore } from '@mindlynx/metis-ports';
import { DataGateway } from '../gateway.js';

describe('DataGateway: a registered definition yields CRUD via a fake adapter', () => {
  const buildGateway = () => {
    const adapter = new FakeDataStore();
    const gateway = new DataGateway(adapter);
    gateway.registerDefinition({
      name: 'workflows',
      partitionAttribute: 'PK',
      sortAttribute: 'SK',
      indexes: [{ name: 'byTenant', partitionAttribute: 'gsi1pk', sortAttribute: 'updatedAt' }],
    });
    return gateway;
  };

  it('provides create, read, update and delete through the adapter', async () => {
    const gateway = buildGateway();
    await gateway.create('workflows', { PK: 'WF#t1#wf1', SK: 'VER#1#0', name: 'first' });
    expect((await gateway.read('workflows', { partitionKey: 'WF#t1#wf1', sortKey: 'VER#1#0' }))?.name).toBe(
      'first',
    );
    await gateway.update('workflows', { partitionKey: 'WF#t1#wf1', sortKey: 'VER#1#0' }, { name: 'renamed' });
    expect((await gateway.read('workflows', { partitionKey: 'WF#t1#wf1', sortKey: 'VER#1#0' }))?.name).toBe(
      'renamed',
    );
    await gateway.remove('workflows', { partitionKey: 'WF#t1#wf1', sortKey: 'VER#1#0' });
    expect(await gateway.read('workflows', { partitionKey: 'WF#t1#wf1', sortKey: 'VER#1#0' })).toBeUndefined();
  });

  it('create refuses to overwrite an existing item', async () => {
    const gateway = buildGateway();
    await gateway.create('workflows', { PK: 'WF#t1#wf1', SK: 'VER#1#0' });
    await expect(gateway.create('workflows', { PK: 'WF#t1#wf1', SK: 'VER#1#0' })).rejects.toThrow(/exists/i);
  });

  it('rejects writes with missing key attributes', async () => {
    const gateway = buildGateway();
    await expect(gateway.create('workflows', { SK: 'VER#1#0' })).rejects.toThrow(/partition/i);
    await expect(gateway.create('workflows', { PK: 'WF#t1#wf1' })).rejects.toThrow(/sort/i);
  });

  it('rejects access to undefined definitions', async () => {
    const gateway = buildGateway();
    await expect(gateway.read('mystery', { partitionKey: 'p' })).rejects.toThrow(/definition/i);
  });

  it('queries through the definition, indexes included', async () => {
    const gateway = buildGateway();
    await gateway.create('workflows', {
      PK: 'WF#t1#a',
      SK: 'VER#1#0',
      gsi1pk: 'TENANT#t1',
      updatedAt: '2026-02-01',
    });
    await gateway.create('workflows', {
      PK: 'WF#t1#b',
      SK: 'VER#1#0',
      gsi1pk: 'TENANT#t1',
      updatedAt: '2026-01-01',
    });
    const page = await gateway.query({
      table: 'workflows',
      index: 'byTenant',
      partitionValue: 'TENANT#t1',
      ascending: false,
    });
    expect(page.items.map((i) => i.PK)).toEqual(['WF#t1#a', 'WF#t1#b']);
  });
});
