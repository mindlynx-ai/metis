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
 * The one error handler. Without it a route that throws produced Fastify's
 * default 500 and, with the logger off, the stack went nowhere at all: the
 * operator had a 500 in the browser and an empty terminal. Signalling a closed
 * run answered 500 instead of 404; a lost conditional write answered 500
 * instead of 409; every cloud failure answered 500 whatever it was.
 *
 * Two rules:
 *
 * 1. A typed error the caller can act on gets its status and a sentence written
 *    FOR the caller. The uplift errors already carry one (their own docstrings
 *    say the message is written for whoever has to change the step), so those
 *    pass through; the rest get a fixed sentence, because their messages name
 *    stored values.
 * 2. Everything else is a 500 whose body says nothing. An unhandled message can
 *    carry a connection string, a query or a credential path, so the detail
 *    goes to the log and the caller gets the request id to quote.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ConditionFailedError,
  ContractMismatchError,
  GatewayRefusedError,
  GatewayUnreachableError,
  UnentitledError,
} from '@mindlynx/metis-ports';

interface Mapped {
  status: number;
  message: string;
}

function mapError(error: Error): Mapped | undefined {
  if (error instanceof ConditionFailedError) {
    return { status: 409, message: 'the resource changed since it was read; reload and retry' };
  }
  if (error instanceof UnentitledError) return { status: 402, message: error.message };
  if (error instanceof GatewayRefusedError) return { status: 502, message: error.message };
  if (error instanceof ContractMismatchError) return { status: 502, message: error.message };
  if (error instanceof GatewayUnreachableError) return { status: 503, message: error.message };
  // Matched by name rather than instanceof: metis-core does not import
  // @temporalio and is not going to start. Temporal defines `name` on the
  // prototype of its error classes, so this is as stable as the class itself.
  if (error.name === 'WorkflowNotFoundError') {
    return { status: 404, message: 'no such run, or it has fallen out of retention' };
  }
  return undefined;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Fastify's own 4xx (malformed body, unsupported content type) already
    // carries the right status and a message written for the caller.
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    const mapped = mapError(error);
    if (mapped) {
      // Refusals are the normal working of the system, so they sit below the
      // default level: visible when someone turns the log up, not by default.
      request.log.info(
        { err: error, method: request.method, url: request.url },
        'request refused',
      );
      return reply.code(mapped.status).send({ error: mapped.message });
    }
    request.log.error(
      { err: error, reqId: request.id, method: request.method, url: request.url },
      'unhandled route error',
    );
    return reply.code(500).send({ error: 'internal error', requestId: request.id });
  });
}
