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
 * The MCP server's HTTP client for the Metis control plane. Its own module
 * because `mcp.ts` is at its line cap, and because this is the whole of the
 * transport: everything else in the server is tool wiring on top of it.
 */

export interface McpEnv {
  url: string;
  token?: string;
  user: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

/** A tiny authenticated client for the Metis control plane. */
export class MetisApiClient {
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly env: McpEnv) {
    this.token = env.token;
    this.fetchImpl = env.fetchImpl ?? fetch;
  }

  /**
   * Say what went wrong AND where, because the caller is an AI tool reading one
   * line of text. "fetch failed" is what `fetch` throws for a refused
   * connection, a wrong port and an unresolvable host alike, and it names none
   * of them - so the commonest failure of all (Metis is not running yet) read
   * as an unexplained dead end.
   */
  private async fetchOrExplain(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (cause) {
      throw new Error(
        `cannot reach Metis at ${this.env.url} (${cause instanceof Error ? cause.message : String(cause)}). `
          + 'Start it with `metis up`, or point METIS_URL at a running instance.',
      );
    }
  }

  private async login(): Promise<string> {
    const response = await this.fetchOrExplain(`${this.env.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: this.env.user, secret: this.env.secret }),
    });
    if (!response.ok) throw new Error(`login failed (${response.status}) - set METIS_TOKEN or METIS_USER/METIS_SECRET`);
    const body = (await response.json()) as { token: string };
    this.token = body.token;
    return body.token;
  }

  async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = this.token ?? (await this.login());
    const response = await this.fetchOrExplain(`${this.env.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && !retried) {
      // The token died (restart, expiry): log in once and retry.
      //
      // ONCE. This used to recurse with no limit, which is fine while a fresh
      // token works but hangs the server outright if one does not - a rotated
      // signing key, clock skew, an evicted session. An MCP server that never
      // returns is worse than one that reports the 401, because the tool
      // calling it simply waits.
      this.token = undefined;
      await this.login();
      return this.call(method, path, body, true);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${method} ${path} -> ${response.status}: ${detail.slice(0, 300)}`);
    }
    // 204 (delete) and other empty responses have no JSON body.
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}
