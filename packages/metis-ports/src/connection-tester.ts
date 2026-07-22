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
 * Testing a connection's health (observability): can we actually reach the
 * service with the stored credentials? The tester is injected so metis-core
 * depends only on this port; the concrete tester (which owns pg and an
 * SSRF-guarded fetch) is wired by the runtime. It receives already-resolved
 * material and returns only a verdict, never the material itself.
 */
export type ConnectionStatus = 'ok' | 'auth_failed' | 'unreachable' | 'error';

export interface ConnectionHealth {
  status: ConnectionStatus;
  /** Convenience mirror of status === 'ok'. */
  ok: boolean;
  message?: string;
  /** ISO timestamp of the check. */
  checkedAt: string;
}

export interface ConnectionTestInput {
  connectorId: string;
  /** The connector's connection method (bearer/header/basic/database/none). */
  authScheme: string;
  baseUrl?: string;
  /** The header a `header`-scheme connector carries its key in (default x-api-key). */
  authHeaderName?: string;
  material: Record<string, string>;
  /**
   * A custom auth probe (method + path relative to baseUrl + optional body) for
   * connectors whose root URL does not validate the key. When absent the tester
   * does a bare GET of the base URL.
   */
  healthCheck?: { method: string; path: string; body?: Record<string, unknown> };
}

export interface ConnectionTester {
  testConnection(input: ConnectionTestInput): Promise<ConnectionHealth>;
}
