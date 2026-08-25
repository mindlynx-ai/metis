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
 * Does this code parse? The editor asks; the real engine answers.
 *
 * The checker itself lives in metis-nodes, beside the runners that will execute
 * the code, and is INJECTED here - metis-core does not depend on metis-nodes,
 * and the module boundary gate exists to keep it that way. Same shape as the
 * connection tester and the data sources.
 *
 * Nothing is executed, so this is safe to call on every keystroke.
 */
import type { FastifyInstance } from 'fastify';
import { requireAction } from './auth-gate.js';

export type SyntaxCheck = (
  language: string,
  code: string,
) => Promise<{ ok: true } | { ok: false; message: string; line?: number; column?: number }>;

/** Code is authored, so this is an edit-level action rather than a read. */
export function registerCodeValidateRoutes(app: FastifyInstance, check: SyntaxCheck): void {
  app.post(
    '/api/code/validate',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const body = (request.body ?? {}) as { language?: string; code?: string };
      if (typeof body.code !== 'string' || !body.language) {
        return reply.code(400).send({ error: 'language and code are required' });
      }
      // An empty step is not a syntax error - it is a step nobody has written
      // yet, and publish already refuses it by name.
      if (body.code.trim() === '') return reply.send({ ok: true });
      return reply.send(await check(body.language, body.code));
    },
  );
}
