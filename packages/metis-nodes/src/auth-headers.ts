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
 * The one place credential material becomes HTTP auth headers, shared by the
 * connector node (runtime calls) and the connection tester (health probes).
 * For bearer, accessToken covers OAuth connections; apiKey/token cover
 * key-based ones; secretKey (Stripe) and botToken (Slack) cover multi-field
 * connectors' primary key.
 */
export function authHeadersFromMaterial(
  scheme: string | undefined,
  material: Record<string, string>,
  headerName?: string,
): Record<string, string> {
  switch (scheme) {
    case 'bearer':
      return {
        authorization: `Bearer ${material.accessToken ?? material.apiKey ?? material.token ?? material.secretKey ?? material.botToken ?? ''}`,
      };
    case 'header':
      return { [headerName ?? 'x-api-key']: material.apiKey ?? '' };
    case 'basic': {
      const pair = `${material.user ?? ''}:${material.password ?? ''}`;
      return { authorization: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}` };
    }
    default:
      return {};
  }
}
