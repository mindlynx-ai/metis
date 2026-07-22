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
 * Database connectors: infrastructure connections reached by a driver, not
 * HTTP. They are kept OUT of the frozen top-100 SaaS catalogue
 * (connectors.v1.json, which requires an http(s) baseUrl and is length-locked)
 * and merged into the served connector list instead. All share the `database`
 * auth scheme, so the one connect form renders host/port/database/user/password
 * for every engine. A typed database node (e.g. postgres) references one by id;
 * mysql and sqlserver are connect-only until their execution nodes land.
 */
import type { ConnectorCatalogueRecord } from './loader.js';

export const DATABASE_CONNECTORS: ConnectorCatalogueRecord[] = [
  {
    connectorId: 'postgres',
    name: 'PostgreSQL',
    baseUrl: 'postgresql://',
    authScheme: 'database',
    tier: 'open',
    category: 'database',
    provenance: { source: 'metis', licence: 'apache-2.0' },
  },
  {
    connectorId: 'mysql',
    name: 'MySQL',
    baseUrl: 'mysql://',
    authScheme: 'database',
    tier: 'open',
    category: 'database',
    provenance: { source: 'metis', licence: 'apache-2.0' },
  },
  {
    connectorId: 'sqlserver',
    name: 'SQL Server',
    baseUrl: 'sqlserver://',
    authScheme: 'database',
    tier: 'open',
    category: 'database',
    provenance: { source: 'metis', licence: 'apache-2.0' },
  },
];
