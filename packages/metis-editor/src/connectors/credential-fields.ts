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
 * Which credential fields a connection needs. The server ships each
 * connector's own schema (`connector.credentials`, stamped by the catalogue);
 * the scheme switch below is the editor-side fallback for the few flows with
 * no connector record at hand (the manual database form, editing a connection
 * whose type is unknown). Keep it in sync with the catalogue's
 * connector-credentials.ts; the editor deliberately imports no backend code.
 */
import { type ConnectorDef, type CredentialFieldDef } from '../api.js';

/** The generic credential fields per auth scheme, when a connector declares none. */
export function fieldsForScheme(scheme?: string): CredentialFieldDef[] {
  switch (scheme) {
    case 'bearer':
      return [{ key: 'token', label: 'API token or key', secret: true, required: true }];
    case 'header':
      return [{ key: 'apiKey', label: 'API key', secret: true, required: true }];
    case 'basic':
      return [
        { key: 'user', label: 'Username', required: true },
        { key: 'password', label: 'Password', secret: true, required: true },
      ];
    case 'database':
      return [
        { key: 'host', label: 'Host', required: true, placeholder: 'db.example.com' },
        { key: 'port', label: 'Port', placeholder: '5432' },
        { key: 'database', label: 'Database', required: true },
        { key: 'user', label: 'Username', required: true },
        { key: 'password', label: 'Password', secret: true, required: true },
      ];
    default:
      return [];
  }
}

/** A connector's own credential schema, else the generic set for its scheme. */
export function credentialFields(
  connector: Pick<ConnectorDef, 'credentials' | 'authScheme'>,
): CredentialFieldDef[] {
  return connector.credentials && connector.credentials.length > 0
    ? connector.credentials
    : fieldsForScheme(connector.authScheme);
}
