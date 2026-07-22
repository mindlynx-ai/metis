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
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Action, IdentityPort } from '@mindlynx/metis-ports';

/** Per-route action gate: simple roles decide view vs edit vs admin. */
export function requireAction(action: Action) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const session = request.session;
    const identity = (request.server as unknown as { metisIdentity: IdentityPort }).metisIdentity;
    if (!session || !identity.can(session, action)) {
      await reply.code(403).send({ error: `requires ${action} permission` });
      return reply;
    }
    return undefined;
  };
}
