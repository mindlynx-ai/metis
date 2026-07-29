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
 * execution path, so no declared node ever resolves to "unimplemented" by
 * accident. A type is covered if it is (a) a registered handler, (b) a
 * config-only trigger (seeds state, never executed), or (c) an inline-control
 * node the engine special-cases (switch/signal/waituntil/logic).
 *
 * The one deliberate exception is a PAID local step (an approval): the
 * catalogue is one file across editions, so its entry ships here while its
 * handler ships only in the paid pack. That is the upgrade path, and the
 * second test holds it to being exactly that and never a quiet gap.
 */
import { describe, it, expect } from 'vitest';
import {
  EXECUTABLE_DATABASE_ENGINES,
  databaseNodeTypeIds,
  databaseNodeTypes,
  getCatalogue,
} from '@mindlynx/metis-catalogue';
import { NodeHandlerRegistry, FakeCredentialPort } from '@mindlynx/metis-ports';
import { buildDataSources } from '../register.js';
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

/** A paid step with no cloud backend: its handler is in the paid pack, so
 *  this build cannot run it (a 'both' entry always has a local backend). */
const isPaidLocal = (entry: { entitlement?: string; execution?: string }): boolean =>
  Boolean(entry.entitlement) && entry.execution !== 'both';

describe('node-type coverage', () => {
  it('every catalogue node type has an execution path (none unimplemented)', () => {
    const registry = buildRegistry();
    const catalogue = getCatalogue();
    expect(catalogue.entries.length).toBeGreaterThanOrEqual(15);

    const uncovered = catalogue.entries
      // `connector` is not-a-node (a credential concept, never executed).
      .filter((entry) => entry.handler_status !== 'not-a-node' && !isPaidLocal(entry))
      .map((entry) => entry.type)
      .filter(
        (type) =>
          !registry.canExecute(type) && !CONFIG_ONLY.has(type) && !INLINE_CONTROL.has(type),
      );

    expect(uncovered).toEqual([]);
  });

  it('a paid step is unregistered here, so it answers with the upgrade path', async () => {
    const registry = buildRegistry();
    const paid = getCatalogue().entries.filter(isPaidLocal);
    // The paid capabilities this build sells; if one ever registers here by
    // accident it would ship for free, which this catches.
    expect(paid.map((entry) => entry.type)).toContain('approval');
    for (const entry of paid) {
      expect(registry.canExecute(entry.type)).toBe(false);
      const result = await registry.execute({
        nodeRef: { id: 'n1', type: entry.type, config: {} },
        tenantId: 't1',
        executionId: 'e1',
        workflowId: 'w1',
        workflowState: { states: [] },
      });
      // Structured, and it says what to do about it: never a crash, never a
      // silent completion that lets the run carry on as though it had run.
      expect(result.status).toBe(501);
      expect(result.message).toMatch(/not available in this edition/i);
      expect(result.message).toMatch(/upgrade/i);
    }
  });

  it('the registered handlers include the core nodes and the wired connector nodes', () => {
    const registry = buildRegistry();
    // Core nodes plus a couple of generated connector node types.
    for (const type of ['api', 'http', 'code', 'transform', 'postgres', 'sendgrid', 'github', 'slack']) {
      expect(registry.canExecute(type)).toBe(true);
    }
  });
});

describe('every executable database engine is reachable and named', () => {
  it('the palette names exactly the engines that have adapters', () => {
    // The two lists live in packages that cannot import one another: the
    // catalogue decides which nodes exist, the registry decides what can run.
    // If they drift, the palette either offers an engine that cannot execute
    // or hides one that can, and neither failure is visible until a run.
    const declared = EXECUTABLE_DATABASE_ENGINES.map((e) => e.engine).sort();
    expect(buildDataSources().engines()).toEqual(declared);
  });

  it('registers a handler for each generated database node type', () => {
    const registry = registerOpenNodeHandlers(new NodeHandlerRegistry(), {
      credentials: new FakeCredentialPort(),
    });
    for (const type of databaseNodeTypeIds()) {
      expect(registry.canExecute(type), `no handler for "${type}"`).toBe(true);
    }
  });

  it('names an engine node after the engine, so Snowflake is findable as Snowflake', () => {
    const labels = databaseNodeTypes().map((entry) => (entry.palette as { label: string }).label);
    expect(labels).toContain('Snowflake');
    expect(labels).toContain('MySQL');
    // Postgres keeps its own hand-written node rather than gaining a second.
    expect(databaseNodeTypeIds()).not.toContain('postgres');
  });
});
