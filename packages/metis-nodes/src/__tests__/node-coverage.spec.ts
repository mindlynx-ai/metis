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
 * The completeness proof: every node type in the catalogue has a real
 * execution path, so no declared node ever resolves to "unimplemented".
 * A type is covered if it is (a) a registered handler, (b) a config-only
 * trigger (seeds state, never executed), or (c) an inline-control node the
 * engine special-cases (switch/signal/waituntil/logic).
 */
import { describe, it, expect } from 'vitest';
import { getCatalogue } from '@mindlynx/metis-catalogue';
import { NodeHandlerRegistry, FakeCredentialPort } from '@mindlynx/metis-ports';
import { DataGateway, MemoryAdapter } from '@mindlynx/metis-data-gateway';
import { registerOpenNodeHandlers } from '../register.js';
import { ConnectorRegistry, registerConnectorTable } from '../connector-registry.js';

// Config-only trigger types: seeded from the run input, never dispatched
// (metis-engine CONFIG_ONLY_NODE_TYPES).
const CONFIG_ONLY = new Set(['apiconfig', 'apiend', 'webhookconfig', 'scheduleconfig']);
// Inline-control types: evaluated in the dispatch activity, not via the port
// (metis-engine create-activities).
const INLINE_CONTROL = new Set([
  'signal',
  'switch',
  'waituntil',
  'logic',
  'noop',
  'stopanderror',
  'merge',
  'loop',
  'filter',
  'comparedatasets',
]);

function buildRegistry(): NodeHandlerRegistry {
  const registry = new NodeHandlerRegistry();
  const gateway = new DataGateway(new MemoryAdapter());
  registerConnectorTable(gateway);
  registerOpenNodeHandlers(registry, {
    credentials: new FakeCredentialPort(),
    connectors: new ConnectorRegistry(gateway),
  });
  return registry;
}

describe('node-type coverage', () => {
  it('every catalogue node type has an execution path (none unimplemented)', () => {
    const registry = buildRegistry();
    const catalogue = getCatalogue();
    expect(catalogue.entries.length).toBeGreaterThanOrEqual(15);

    const uncovered = catalogue.entries
      // `connector` is not-a-node (a credential concept, never executed).
      .filter((entry) => entry.handler_status !== 'not-a-node')
      .map((entry) => entry.type)
      .filter(
        (type) =>
          !registry.canExecute(type) && !CONFIG_ONLY.has(type) && !INLINE_CONTROL.has(type),
      );

    expect(uncovered).toEqual([]);
  });

  it('the registered handlers include the core nodes and the wired connector nodes', () => {
    const registry = buildRegistry();
    // Core nodes plus a couple of generated connector node types.
    for (const type of ['api', 'http', 'code', 'transform', 'postgres', 'sendgrid', 'github', 'slack']) {
      expect(registry.canExecute(type)).toBe(true);
    }
  });
});
