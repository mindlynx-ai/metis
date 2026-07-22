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
 * A real connector end-to-end: the connector node, operation mode, a path
 * placeholder, and a real external HTTP call (no stub). Network-gated on
 * CONNECTOR_NET_TEST=1 so the default suite stays hermetic.
 */
import { describe, it, expect } from 'vitest';
import { FakeCredentialPort, nodeCtx, nodeOutput } from '@mindlynx/metis-ports';
import { DataGateway, MemoryAdapter } from '@mindlynx/metis-data-gateway';
import { createConnectorNodeHandler } from '../connector-node.js';
import { ConnectorRegistry, registerConnectorTable } from '../connector-registry.js';

const run = process.env.CONNECTOR_NET_TEST === '1' ? describe : describe.skip;

run('connector node against a real API', () => {
  it('calls an operation with a path placeholder against jsonplaceholder', async () => {
    const gateway = new DataGateway(new MemoryAdapter());
    registerConnectorTable(gateway);
    const registry = new ConnectorRegistry(gateway);
    await registry.register('t1', {
      connectorId: 'jsonph',
      name: 'JSONPlaceholder',
      baseUrl: 'https://jsonplaceholder.typicode.com',
      authScheme: 'none',
      operations: [
        { name: 'getTodo', method: 'GET', pathTemplate: '/todos/{id}', wireStatus: 'verified' },
      ],
    });
    const handler = createConnectorNodeHandler(registry, new FakeCredentialPort());

    const result = await handler(
      nodeCtx('connector', { connectorId: 'jsonph', operation: 'getTodo', params: { id: 1 } }),
    );

    expect(result.status).toBe(200);
    const output = nodeOutput(result) as { status: number; data: { id: number; title: string } };
    expect(output.status).toBe(200);
    expect(output.data.id).toBe(1);
    expect(typeof output.data.title).toBe('string');
  }, 15_000);
});
