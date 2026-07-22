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
 * The CredentialPort: resolve secret material for
 * a node at dispatch time. Secret tokens pass through the engine
 * untouched and are substituted only at this boundary, so secret
 * material never enters workflow memory or logs.
 */
export interface SecretRequest {
  tenantId: string;
  secretId: string;
  /** Optional dot path into a structured secret. */
  path?: string;
}

export interface CredentialPort {
  resolveSecret(request: SecretRequest): Promise<string>;
  /** Resolve a connection instance's auth material by its connection id. */
  resolveConnectorCredentials(tenantId: string, connectionId: string): Promise<Record<string, string>>;
}

/**
 * A connection: a NAMED INSTANCE of a connector type, with its own auth
 * material. A connector type (e.g. sendgrid, postgres) can have several
 * connections ("SendGrid Prod", "SendGrid Test"); a node references one by its
 * connection id. The metadata (name, type) is projectable; the material is not.
 */
export interface ConnectionRecord {
  connectionId: string;
  name: string;
  /** The connector TYPE this is an instance of (a catalogue id, or the class). */
  connectorId: string;
  /** The connection class: rest | client_credentials | database. */
  connectionType?: string;
  /** The base URL for rest / client_credentials connections. */
  baseUrl?: string;
  /** How the connection authenticates (bearer/header/basic/client_credentials/database/none). */
  authScheme?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The fields to create a connection (material is the secret part). */
export interface CreateConnectionInput {
  name: string;
  connectorId: string;
  connectionType?: string;
  baseUrl?: string;
  authScheme?: string;
  material: Record<string, string>;
}

/**
 * A CredentialPort that also manages connections (named connector instances):
 * create, update, remove, and list them. Material is stored encrypted and never
 * returned by list(); the connections front-end requires this store.
 */
export interface ConnectorCredentialStore extends CredentialPort {
  createConnection(tenantId: string, input: CreateConnectionInput): Promise<ConnectionRecord>;
  updateConnection(
    tenantId: string,
    connectionId: string,
    changes: { name?: string; material?: Record<string, string> },
  ): Promise<void>;
  deleteConnection(tenantId: string, connectionId: string): Promise<void>;
  /** The tenant's connections (metadata only, never material). */
  listConnections(tenantId: string): Promise<ConnectionRecord[]>;
}
