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
import type { CredentialPort } from './credential-port.js';

const SECRET_TOKEN =
  /{{secrets\.([0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12})}}/gi;

/**
 * Substitute `{{secrets.<uuid>}}` tokens at the CredentialPort boundary
 *. The engine passes these tokens through untouched; only the
 * dispatch path, immediately before a node executes, may resolve them,
 * so secret material never enters engine memory or logs.
 */
export async function resolveSecretTokens(
  config: unknown,
  tenantId: string,
  credentials: CredentialPort,
): Promise<unknown> {
  const configData = JSON.stringify(config);
  const secretIds = [...new Set([...configData.matchAll(SECRET_TOKEN)].map((m) => m[1] ?? ''))];
  if (secretIds.length === 0) return config;

  let resolved = configData;
  for (const secretId of secretIds) {
    const value = await credentials.resolveSecret({ tenantId, secretId });
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
    resolved = resolved.replaceAll(`{{secrets.${secretId}}}`, escaped);
  }
  return JSON.parse(resolved);
}
