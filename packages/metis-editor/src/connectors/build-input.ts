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
 * The connection classes a user can create, and the pure mapping from the
 * chosen class + form values to the create-connection payload.
 */
import { type ConnectorDef } from '../api.js';
import { credentialFields } from './credential-fields.js';

export type ConnClass = 'service' | 'rest' | 'client_credentials' | 'database';

export const CLASSES: { key: ConnClass; label: string; hint: string }[] = [
  { key: 'service', label: 'A service', hint: 'A known app: GitHub, Stripe, Slack…' },
  { key: 'rest', label: 'API / REST', hint: 'Any HTTP API with a base URL + key.' },
  { key: 'client_credentials', label: 'Machine-to-machine', hint: 'OAuth2 client credentials.' },
  { key: 'database', label: 'Database', hint: 'Postgres, MySQL or SQL Server.' },
];

export interface CreateInput {
  name: string;
  connectorId: string;
  connectionType?: string;
  baseUrl?: string;
  authScheme?: string;
  material: Record<string, string>;
}

/** Build the create payload for the chosen class from the values bag. */
export function buildInput(
  connClass: ConnClass,
  name: string,
  v: Record<string, string>,
  service: ConnectorDef | undefined,
): CreateInput {
  if (connClass === 'service' && service) {
    const material: Record<string, string> = {};
    for (const f of credentialFields(service)) if (v[f.key]) material[f.key] = v[f.key];
    return {
      name,
      connectorId: service.connectorId,
      connectionType: service.authScheme === 'database' ? 'database' : 'rest',
      baseUrl: service.baseUrl,
      authScheme: service.authScheme,
      material,
    };
  }
  if (connClass === 'database') {
    return {
      name,
      connectorId: v.engine || 'postgres',
      connectionType: 'database',
      authScheme: 'database',
      material: {
        host: v.host ?? '',
        port: v.port ?? '',
        database: v.database ?? '',
        user: v.user ?? '',
        password: v.password ?? '',
      },
    };
  }
  if (connClass === 'client_credentials') {
    return {
      name,
      connectorId: 'client_credentials',
      connectionType: 'client_credentials',
      baseUrl: v.tokenUrl,
      authScheme: 'client_credentials',
      material: {
        tokenUrl: v.tokenUrl ?? '',
        clientId: v.clientId ?? '',
        clientSecret: v.clientSecret ?? '',
        ...(v.scopes ? { scopes: v.scopes } : {}),
      },
    };
  }
  const method = v.authMethod || 'bearer';
  let authScheme = 'bearer';
  let material: Record<string, string> = { token: v.token ?? '' };
  if (method === 'api_key') {
    authScheme = 'header';
    material = { apiKey: v.apiKey ?? '' };
  } else if (method === 'basic') {
    authScheme = 'basic';
    material = { user: v.user ?? '', password: v.password ?? '' };
  }
  return { name, connectorId: 'rest', connectionType: 'rest', baseUrl: v.baseUrl, authScheme, material };
}
