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
 * Boot-time registration of the open node handlers.
 * registerNodeHandler on the NodeHandlerRegistry is the plugin
 * boundary: paid packs would register their types through exactly this
 * seam; without a registration a type resolves to the structured
 * upgrade response, never a crash.
 */
import type { CredentialPort } from '@mindlynx/metis-ports';
import { NodeHandlerRegistry } from '@mindlynx/metis-ports';
import { connectorNodeTypeIds } from '@mindlynx/metis-catalogue';
import { DataSourceRegistry } from '@mindlynx/metis-ports';
import { createHttpNodeHandler } from './http-node.js';
import { createCodeNodeHandler } from './code-node.js';
import { createPostgresNodeHandler } from './postgres-node.js';
import { PostgresDataSource } from './postgres-data-source.js';
import { createDataNodeHandler } from './data-node.js';
import { createSendgridNodeHandler, type SendgridNodeOptions } from './sendgrid-node.js';
import { createConnectorNodeHandler } from './connector-node.js';
import type { ConnectorRegistry } from './connector-registry.js';

export interface OpenNodeDependencies {
  credentials: CredentialPort;
  connectors?: ConnectorRegistry;
  sendgrid?: SendgridNodeOptions;
}

/** The open-edition data sources for the Data node + the table catalogue route:
 *  postgres today; athena/snowflake are adapters in the Helix build. Shared so
 *  the worker (node handler) and core (table listing) dispatch the same way. */
export function buildDataSources(): DataSourceRegistry {
  return new DataSourceRegistry().register(new PostgresDataSource());
}

export function registerOpenNodeHandlers(
  registry: NodeHandlerRegistry,
  deps: OpenNodeDependencies,
): NodeHandlerRegistry {
  const http = createHttpNodeHandler();
  const code = createCodeNodeHandler();
  registry.registerNodeHandler('api', http);
  registry.registerNodeHandler('http', http);
  registry.registerNodeHandler('code', code);
  registry.registerNodeHandler('transform', code);
  const postgres = createPostgresNodeHandler(deps.credentials);
  registry.registerNodeHandler('postgres', postgres);
  // The SQL transform node is the postgres handler's raw-query mode (a
  // connection + a query string), surfaced as its own transform step.
  registry.registerNodeHandler('sql', postgres);
  // The generic Data node: engine-agnostic, dispatches via the DataSource port
  // (postgres in the open edition; athena/snowflake are adapters in Helix).
  registry.registerNodeHandler('data', createDataNodeHandler(buildDataSources(), deps.credentials));
  registry.registerNodeHandler('sendgrid', createSendgridNodeHandler(deps.credentials, deps.sendgrid));
  if (deps.connectors) {
    // One shared handler under every wired-connector node type; the handler
    // reads the connector from the node type and the connection from config.
    const connectorHandler = createConnectorNodeHandler(deps.connectors, deps.credentials);
    for (const type of connectorNodeTypeIds()) {
      registry.registerNodeHandler(type, connectorHandler);
    }
  }
  return registry;
}
