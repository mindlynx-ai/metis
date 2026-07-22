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
 * The email/sendgrid node: posts to the SendGrid v3 mail-send
 * API with the connector api key resolved at the CredentialPort
 * boundary. The base URL is injectable so tests run against a local
 * stub; secret material never appears in outputs or errors.
 */
import { stateEnvelope, type CredentialPort, type NodeHandler } from '@mindlynx/metis-ports';

const SENDGRID_BASE_URL = 'https://api.sendgrid.com';

interface SendgridNodeConfig {
  connectorId?: string;
  /** The chosen connection instance id (material is resolved from this). */
  connectionId?: string;
  to?: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
}

export interface SendgridNodeOptions {
  baseUrl?: string;
}

export function createSendgridNodeHandler(
  credentials: CredentialPort,
  options: SendgridNodeOptions = {},
): NodeHandler {
  const baseUrl = options.baseUrl ?? SENDGRID_BASE_URL;
  return async (ctx) => {
    const config = ctx.nodeRef.config as SendgridNodeConfig;
    const connectorId = String(config.connectorId ?? '');
    if (!connectorId || !config.to || !config.from) {
      return { status: 400, message: 'sendgrid node requires connectorId, to and from' };
    }
    // Resolve material from the chosen connection instance; fall back to the
    // connector type id so a single unnamed connection still resolves.
    const connectionId = String(config.connectionId ?? connectorId);
    let apiKey: string;
    try {
      const material = await credentials.resolveConnectorCredentials(ctx.tenantId, connectionId);
      apiKey = material.apiKey ?? '';
    } catch {
      return {
        status: 500,
        message: `could not resolve credentials for connection "${connectionId}"`,
        nodeData: { code: 'credentials' },
      };
    }
    if (!apiKey) {
      return { status: 500, message: 'sendgrid connector has no apiKey' };
    }

    const content = [
      ...(config.text ? [{ type: 'text/plain', value: config.text }] : []),
      ...(config.html ? [{ type: 'text/html', value: config.html }] : []),
    ];
    try {
      const response = await fetch(`${baseUrl}/v3/mail/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: config.to }] }],
          from: { email: config.from },
          subject: config.subject ?? '',
          content,
        }),
      });
      if (response.status >= 200 && response.status < 300) {
        return {
          status: 200,
          message: 'ok',
          nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, { status: response.status }),
        };
      }
      const detail = await response.text();
      return { status: 502, message: `sendgrid responded ${response.status}: ${detail.slice(0, 200)}` };
    } catch (error) {
      return { status: 502, message: error instanceof Error ? error.message : String(error) };
    }
  };
}
