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
import { connectorNodeTypeIds, databaseNodeTypeIds } from '@mindlynx/metis-catalogue';
import { registerApprovalNodes } from '@mindlynx/metis-approvals';
import { DataSourceRegistry } from '@mindlynx/metis-ports';
import { createHttpNodeHandler } from './http-node.js';
import { createCodeNodeHandler } from './code-node.js';
import { createPostgresNodeHandler } from './postgres-node.js';
import { PostgresDataSource } from './postgres-data-source.js';
import { MysqlDataSource } from './mysql-data-source.js';
import { SnowflakeDataSource } from './snowflake-data-source.js';
import { loadSqlServer } from './sqlserver-data-source.js';
import { createDataNodeHandler } from './data-node.js';
import { createSendgridNodeHandler, type SendgridNodeOptions } from './sendgrid-node.js';
import { createS3NodeHandler } from './s3-node.js';
import { createConnectorNodeHandler } from './connector-node.js';
import type { ConnectorRegistry } from './connector-registry.js';

export interface OpenNodeDependencies {
  credentials: CredentialPort;
  connectors?: ConnectorRegistry;
  sendgrid?: SendgridNodeOptions;
}

/** The open-edition data sources for the Data node + the table catalogue route:
 *  postgres, mysql, snowflake and sqlserver; athena is an adapter in the Helix
 *  build. Shared so the worker (node handler) and core (table listing)
 *  dispatch the same way.
 *
 *  sqlserver is registered only when its optional driver is installed. An
 *  install that omitted it leaves the registry exactly as it is for athena, and
 *  every surface downstream already knows what to do with an engine that has no
 *  adapter. `resolve` is the seam a test drives, because the honest way to prove
 *  an absent optional dependency is the resolution path, not uninstalling the
 *  package underneath a running suite. */
export function buildDataSources(resolve?: (id: string) => string): DataSourceRegistry {
  const registry = new DataSourceRegistry()
    .register(new PostgresDataSource())
    .register(new MysqlDataSource())
    .register(new SnowflakeDataSource());
  const sqlServer = loadSqlServer(resolve);
  return sqlServer ? registry.register(sqlServer) : registry;
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
  const data = createDataNodeHandler(buildDataSources(), deps.credentials);
  registry.registerNodeHandler('data', data);
  // A node per executable engine (mysql, snowflake, ...), so an operator who
  // connects one finds it in the palette by name instead of having to know
  // that the way in is a generic Data step. The engine comes from the type.
  for (const type of databaseNodeTypeIds()) {
    registry.registerNodeHandler(type, data);
  }
  // The sign-off gate. It parks the run on the same Temporal condition a signal
  // node has always used, so it needs no dependency of its own and nothing
  // hosted: a run that waits for a person is something a workflow engine has to
  // have, not something to sell back to the person who needs it.
  registerApprovalNodes(registry);
  registry.registerNodeHandler('sendgrid', createSendgridNodeHandler(deps.credentials, deps.sendgrid));
  // One node for every S3-compatible store: the endpoint and the path-style
  // flag live on the connection, so MinIO, R2 and B2 need no code of their own.
  registry.registerNodeHandler('s3', createS3NodeHandler(deps.credentials));
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
