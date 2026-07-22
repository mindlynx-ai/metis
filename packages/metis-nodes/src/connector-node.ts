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
 * The generic connector node. New to Metis: no such node
 * exists in the live tree (the origin's generic dispatcher targets the
 * Helix node-server). A registered connector record supplies the base
 * URL and auth scheme; the node composes over the http node so the
 * SSRF guard applies, with the connector's own host implicitly
 * allowlisted (operator registration is the trust decision).
 *
 * Two config modes:
 *   - operation mode: { connectorId, operation, params } resolves a
 *     named operation from the record's catalogue, interpolates its
 *     path template from params, and routes leftover params to the query
 *     string (GET/DELETE) or JSON body (POST/PUT/PATCH).
 *   - raw mode (back-compat): { connectorId, method, path, body } calls
 *     a relative path directly.
 * Both share one dispatch tail: relative-path guard, host check, auth at
 * the CredentialPort boundary, then the http node.
 */
import type {
  CredentialPort,
  NodeHandler,
  NodeHandlerContext,
  NodeExecutionResult,
} from '@mindlynx/metis-ports';
import { authHeadersFromMaterial } from './auth-headers.js';
import { createHttpNodeHandler } from './http-node.js';
import {
  findOperation,
  hasUrlScheme,
  type ConnectorRegistry,
  type ConnectorRecord,
  type ConnectorOperation,
} from './connector-registry.js';

interface ConnectorNodeConfig {
  connectorId?: string;
  /** Operation mode: the named operation to dispatch. */
  operation?: string;
  /** Operation-mode inputs: path tokens, query values, and body fields. */
  params?: Record<string, unknown>;
  /** Raw mode: method + relative path. */
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

interface ResolvedCall {
  method: string;
  path: string;
  body?: unknown;
}

async function buildAuthHeaders(
  record: ConnectorRecord,
  credentials: CredentialPort,
  tenantId: string,
  connectionId: string,
): Promise<Record<string, string>> {
  if (record.authScheme === 'none') return {};
  const material = await credentials.resolveConnectorCredentials(tenantId, connectionId);
  return authHeadersFromMaterial(record.authScheme, material, record.authHeaderName);
}

/**
 * Fill {token} placeholders from params and split the remainder into the
 * query string (safe methods) or a JSON body (write methods). Returns a
 * string when a required path token is missing.
 */
function resolveOperationCall(
  operation: ConnectorOperation,
  params: Record<string, unknown>,
): ResolvedCall | string {
  const consumed = new Set<string>();
  const missing: string[] = [];
  const filledPath = operation.pathTemplate.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    const key = token.trim();
    if (!(key in params) || params[key] === undefined || params[key] === null) {
      missing.push(key);
      return '';
    }
    consumed.add(key);
    return encodeURIComponent(String(params[key]));
  });
  if (missing.length > 0) {
    return `operation "${operation.name}" is missing required path parameter(s): ${missing.join(', ')}`;
  }
  const leftover = Object.fromEntries(
    Object.entries(params).filter(([key]) => !consumed.has(key)),
  );
  const isWrite = operation.method === 'POST' || operation.method === 'PUT' || operation.method === 'PATCH';
  if (Object.keys(leftover).length === 0) {
    return { method: operation.method, path: filledPath };
  }
  if (isWrite) {
    return { method: operation.method, path: filledPath, body: leftover };
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(leftover)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const search = query.toString();
  return { method: operation.method, path: search ? `${filledPath}?${search}` : filledPath };
}

export function createConnectorNodeHandler(
  registry: ConnectorRegistry,
  credentials: CredentialPort,
): NodeHandler {
  const http = createHttpNodeHandler();

  const dispatch = async (
    ctx: NodeHandlerContext,
    record: ConnectorRecord,
    call: ResolvedCall,
    extraHeaders: Record<string, string> | undefined,
    timeout: number | undefined,
    connectionId: string,
  ): Promise<NodeExecutionResult> => {
    const path = call.path;
    if (hasUrlScheme(path)) {
      return { status: 400, message: 'connector path must be relative to the connector base URL' };
    }
    let url: URL;
    try {
      url = new URL(path, record.baseUrl);
    } catch {
      return { status: 400, message: `invalid connector path "${path}"` };
    }
    const base = new URL(record.baseUrl);
    if (url.host !== base.host) {
      return { status: 400, message: 'connector path resolves outside the connector host' };
    }

    let authHeaders: Record<string, string>;
    try {
      authHeaders = await buildAuthHeaders(record, credentials, ctx.tenantId, connectionId);
    } catch {
      return {
        status: 500,
        message: `could not resolve credentials for connection "${connectionId}"`,
        nodeData: { code: 'credentials' },
      };
    }

    return http({
      ...ctx,
      nodeRef: {
        ...ctx.nodeRef,
        config: {
          method: call.method,
          url: url.toString(),
          headers: { ...(record.headers ?? {}), ...(extraHeaders ?? {}), ...authHeaders },
          body: call.body,
          timeout,
          allowedHosts: [base.hostname],
        },
      },
    });
  };

  return async (ctx) => {
    const config = ctx.nodeRef.config as ConnectorNodeConfig;
    // The NODE TYPE is the connector (e.g. 'github'); it supplies the base URL,
    // auth scheme and operations. `config.connectorId` is the chosen CONNECTION
    // instance (its id), which supplies the credentials.
    const connectorType = ctx.nodeRef.type;
    const record = await registry.get(ctx.tenantId, connectorType);
    if (!record) {
      return { status: 404, message: `connector "${connectorType}" is not registered` };
    }
    const connectionId = String(config.connectorId ?? '');
    if (!connectionId) {
      return { status: 400, message: `${connectorType} node requires a connection` };
    }

    let call: ResolvedCall;
    if (config.operation) {
      const operation = findOperation(record, config.operation);
      if (!operation) {
        return { status: 404, message: `${connectorType} has no operation "${config.operation}"` };
      }
      if (operation.wireStatus === 'unverified') {
        return {
          status: 400,
          message: `operation "${config.operation}" on "${connectorType}" is unverified and not runnable`,
          nodeData: { code: 'unverified' },
        };
      }
      const resolved = resolveOperationCall(operation, config.params ?? {});
      if (typeof resolved === 'string') {
        return { status: 400, message: resolved };
      }
      call = resolved;
    } else {
      call = { method: config.method ?? 'GET', path: String(config.path ?? '/'), body: config.body };
    }

    return dispatch(ctx, record, call, config.headers, config.timeout, connectionId);
  };
}
