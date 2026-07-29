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
 * Object-store connectors: HTTP, but signed rather than bearing a token, so
 * they belong with neither the frozen top-100 (which is length-locked and
 * assumes an auth header) nor the database connectors (reached by a driver).
 * They are merged into the served connector list so a connection can be made,
 * and they generate NO node type of their own: the object store node is
 * hand-written, exactly as sendgrid's is.
 *
 * One record covers every S3-compatible store. MinIO, R2 and B2 differ only in
 * the endpoint and the addressing style, and both of those are fields on the
 * connection, so a second record would be a second thing to keep in step for
 * no behaviour at all.
 */
import type { ConnectorCatalogueRecord } from './loader.js';

export const STORAGE_CONNECTORS: ConnectorCatalogueRecord[] = [
  {
    connectorId: 's3',
    name: 'S3 Object Store',
    // The real base URL is per region or per endpoint and is built from the
    // connection's own fields; this is the default one a connection with
    // nothing but a region resolves to.
    baseUrl: 'https://s3.amazonaws.com',
    authScheme: 'sigv4',
    tier: 'open',
    category: 'content-and-files',
    provenance: { source: 'metis', licence: 'apache-2.0' },
  },
];
