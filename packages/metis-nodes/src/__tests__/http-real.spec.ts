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
 * Real-service coverage of the http/api node against a public no-auth API.
 * Network-gated: runs only when NET_TEST=1, so the default suite stays
 * hermetic. A public host is not in the SSRF blocklist (checkUrlForSsrf blocks
 * loopback/RFC1918, not public addresses), so no allowedHosts is needed.
 */
import { describe, it, expect } from 'vitest';
import { createHttpNodeHandler } from '../http-node.js';
import { nodeCtx, nodeOutput } from '@mindlynx/metis-ports';

const run = process.env.NET_TEST === '1' ? describe : describe.skip;

const handler = createHttpNodeHandler();

run('http/api node against a real public API', () => {
  it(
    'GETs jsonplaceholder and returns the parsed todo',
    async () => {
      const result = await handler(
        nodeCtx('api', {
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/todos/1',
        }),
      );
      expect(result.status).toBe(200);
      expect((nodeOutput(result) as { data: { id: number } }).data.id).toBe(1);
    },
    15_000,
  );
});
