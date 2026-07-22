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
 * Scoping for the connector picker. A node's connectorRef field carries an
 * `x-helix-options` hint (e.g. `/_resource/connectors?provider=sendgrid`); this
 * turns it into a scope so a typed step (SendGrid) only offers relevant
 * connections (the picker matches connections by exact connectorId).
 */

export interface ConnectorScope {
  provider?: string;
}

/** Parse the `x-helix-options` hint's query string into a scope. */
export function parseConnectorScope(hint: string | undefined): ConnectorScope {
  const query = hint && hint.includes('?') ? hint.slice(hint.indexOf('?') + 1) : '';
  if (!query) return {};
  const params = new URLSearchParams(query);
  const scope: ConnectorScope = {};
  const provider = params.get('provider');
  if (provider) scope.provider = provider;
  return scope;
}
