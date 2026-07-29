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
 * The credential SHAPE of a connector. A connector is rarely a single key -
 * Stripe carries a secret key, a publishable key and a webhook signing secret;
 * a database carries host/port/user/... So each connector declares the fields
 * its connection needs. When a connector has no bespoke schema we fall back to
 * a generic set derived from its auth scheme. The `primary` field is the one
 * the auth header is built from at run time.
 */

export interface CredentialFieldDef {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** The credential the auth header is built from (bearer token / api key). */
  primary?: boolean;
  /** Render as a text area. A PEM private key is many lines, and a single-line
   *  input silently drops the newlines on paste, which corrupts the key. */
  multiline?: boolean;
}

/** Bespoke credential schemas for connectors that are not a single key. */
const CONNECTOR_CREDENTIALS: Record<string, CredentialFieldDef[]> = {
  stripe: [
    { key: 'secretKey', label: 'Secret key', secret: true, required: true, primary: true, placeholder: 'sk_live_… or sk_test_…', help: 'Authenticates API calls. Never shown again once saved.' },
    { key: 'publishableKey', label: 'Publishable key', placeholder: 'pk_live_… or pk_test_…', help: 'Safe to expose in a browser; used by client-side flows.' },
    { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, placeholder: 'whsec_…', help: 'Verifies that incoming Stripe webhooks are genuine.' },
  ],
  snowflake: [
    { key: 'account', label: 'Account identifier', required: true, primary: true, placeholder: 'abc12345.eu-west-1 or myorg-myaccount', help: 'From the account URL. The region suffix is kept for the host and dropped when a token is signed.' },
    { key: 'user', label: 'Username', required: true, placeholder: 'METIS_SERVICE' },
    { key: 'token', label: 'Programmatic access token', secret: true, placeholder: 'The token string Snowflake showed you once', help: 'The simplest option: generate one in Snowsight under your user, or with ALTER USER ... ADD PROGRAMMATIC ACCESS TOKEN. Fill this in OR the private key below, not both. Tokens expire (15 days by default).' },
    { key: 'privateKey', label: 'Private key (PEM)', secret: true, multiline: true, placeholder: 'Paste the whole PEM block, header and footer included', help: 'The alternative to a token, and it does not expire. Snowflake never sees this half: set the matching PUBLIC key on the user with ALTER USER ... SET RSA_PUBLIC_KEY.' },
    { key: 'passphrase', label: 'Private key passphrase', secret: true, help: 'Only if the private key is encrypted.' },
    { key: 'warehouse', label: 'Warehouse', placeholder: 'COMPUTE_WH' },
    { key: 'database', label: 'Database', placeholder: 'METIS_SAMPLE' },
    { key: 'schema', label: 'Schema', placeholder: 'PUBLIC' },
    { key: 'role', label: 'Role', placeholder: 'ACCOUNTADMIN (optional)' },
    { key: 'accountUrl', label: 'Account URL override', placeholder: 'https://... (only for private link)' },
  ],
  sqlserver: [
    { key: 'host', label: 'Host', required: true },
    { key: 'port', label: 'Port', placeholder: '1433' },
    { key: 'database', label: 'Database', required: true },
    { key: 'user', label: 'Username', required: true },
    { key: 'password', label: 'Password', secret: true, required: true },
    { key: 'trustServerCertificate', label: 'Trust the server certificate', placeholder: 'true', help: 'The connection is encrypted either way. Set true when the server presents a self-signed certificate, which is what SQL Server does until a real one is installed; otherwise the connection is refused with a certificate error.' },
  ],
  resend: [
    { key: 'apiKey', label: 'API key', secret: true, required: true, primary: true, placeholder: 're_…' },
  ],
  github: [
    { key: 'token', label: 'Personal access token', secret: true, required: true, primary: true, placeholder: 'ghp_… or github_pat_…', help: 'A fine-grained or classic PAT with the scopes you need.' },
  ],
  hubspot: [
    { key: 'accessToken', label: 'Private app token', secret: true, required: true, primary: true, placeholder: 'pat-…' },
  ],
  slack: [
    { key: 'botToken', label: 'Bot user OAuth token', secret: true, required: true, primary: true, placeholder: 'xoxb-…' },
    { key: 'signingSecret', label: 'Signing secret', secret: true, placeholder: '', help: 'Verifies requests from Slack (events, slash commands).' },
  ],
  sendgrid: [
    { key: 'apiKey', label: 'API key', secret: true, required: true, primary: true, placeholder: 'SG.…' },
  ],
  s3: [
    { key: 'accessKeyId', label: 'Access key ID', required: true, primary: true, placeholder: 'The key id the store issued you' },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true, required: true, help: 'Signs every request. Never shown again once saved, and never sent: only a signature derived from it is.' },
    { key: 'region', label: 'Region', required: true, placeholder: 'eu-west-1', help: 'Part of the signature, so it has to match the bucket. Use us-east-1 for a store that has no regions.' },
    { key: 'bucket', label: 'Bucket', required: true, placeholder: 'my-bucket', help: 'The default bucket; a step can name another.' },
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://... (leave empty for Amazon S3)', help: 'The URL of an S3-compatible store: MinIO, Cloudflare R2, Backblaze B2. Leave empty and the region decides the Amazon endpoint.' },
    { key: 'pathStyle', label: 'Path-style addressing', placeholder: 'true', help: 'Bucket in the path (https://host/bucket/key) rather than the hostname. On by default for a custom endpoint, because most compatible stores have no wildcard DNS.' },
    { key: 'sessionToken', label: 'Session token', secret: true, help: 'Only for temporary credentials (STS). They expire, so a workflow on a schedule wants a long-lived key instead.' },
    { key: 'allowPrivateEndpoint', label: 'Allow a private endpoint', placeholder: 'true', help: 'Required to point at a loopback or private address, e.g. MinIO on this machine. Off by default: an endpoint on a private range is otherwise refused, so a connection cannot be turned into a reader of internal services.' },
  ],
  notion: [
    { key: 'token', label: 'Internal integration secret', secret: true, required: true, primary: true, placeholder: 'secret_… / ntn_…' },
  ],
  airtable: [
    { key: 'token', label: 'Personal access token', secret: true, required: true, primary: true, placeholder: 'pat…' },
  ],
  openai: [
    { key: 'apiKey', label: 'API key', secret: true, required: true, primary: true, placeholder: 'sk-…' },
    { key: 'organization', label: 'Organization ID', placeholder: 'org-… (optional)' },
  ],
  twilio: [
    { key: 'user', label: 'Account SID', required: true, primary: true, placeholder: 'AC…' },
    { key: 'password', label: 'Auth token', secret: true, required: true, placeholder: '' },
  ],
};

/**
 * An authenticated probe the health tester uses instead of a bare GET of the
 * root, for services whose root does not validate the key. Point it at an
 * endpoint that returns 401/403 on a bad key and 2xx on a good one.
 */
export interface ConnectorHealthProbe {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

const CONNECTOR_HEALTHCHECK: Record<string, ConnectorHealthProbe> = {
  stripe: { method: 'GET', path: '/v1/balance' },
  github: { method: 'GET', path: '/user' },
  hubspot: { method: 'GET', path: '/account-info/v3/details' },
  sendgrid: { method: 'GET', path: '/v3/scopes' },
  openai: { method: 'GET', path: '/v1/models' },
};

/** The bespoke health probe for a connector, if it has one. */
export function healthCheckFor(connectorId: string): ConnectorHealthProbe | undefined {
  return CONNECTOR_HEALTHCHECK[connectorId];
}

/** Recognisable brand accents (a hue used for the connector's mark). */
const CONNECTOR_BRAND: Record<string, string> = {
  stripe: '#635bff',
  resend: '#e5484d',
  github: '#6e7681',
  hubspot: '#ff7a59',
  slack: '#611f69',
  sendgrid: '#1a82e2',
  notion: '#787066',
  airtable: '#2d7ff9',
  openai: '#10a37f',
  twilio: '#f22f46',
  postgres: '#31648c',
  mysql: '#00758f',
  sqlserver: '#a4373a',
  s3: '#e25444',
  google: '#4285f4',
  gmail: '#ea4335',
  shopify: '#5a863e',
  gitlab: '#fc6d26',
  discord: '#5865f2',
  zoom: '#2d8cff',
  salesforce: '#00a1e0',
};

/** The generic credential set for a connector that declares no bespoke schema. */
function schemeCredentials(authScheme?: string): CredentialFieldDef[] {
  switch (authScheme) {
    case 'bearer':
      return [{ key: 'token', label: 'API token or key', secret: true, required: true, primary: true }];
    case 'header':
      return [{ key: 'apiKey', label: 'API key', secret: true, required: true, primary: true }];
    case 'basic':
      return [
        { key: 'user', label: 'Username', required: true, primary: true },
        { key: 'password', label: 'Password', secret: true, required: true },
      ];
    case 'database':
      return [
        { key: 'host', label: 'Host', required: true },
        { key: 'port', label: 'Port' },
        { key: 'database', label: 'Database', required: true },
        { key: 'user', label: 'Username', required: true },
        { key: 'password', label: 'Password', secret: true, required: true },
      ];
    default:
      return [];
  }
}

/** The credential fields a connector's connection needs. */
export function credentialSchemaFor(
  connectorId: string | undefined,
  authScheme: string | undefined,
): CredentialFieldDef[] {
  if (connectorId && CONNECTOR_CREDENTIALS[connectorId]) return CONNECTOR_CREDENTIALS[connectorId];
  return schemeCredentials(authScheme);
}

/**
 * A stable brand hue for a connector's mark. Curated for well-known services;
 * otherwise derived deterministically from the id so every connector gets a
 * distinct, consistent colour (used only as a soft wash, so it stays legible).
 */
export function brandColorFor(connectorId: string): string {
  if (CONNECTOR_BRAND[connectorId]) return CONNECTOR_BRAND[connectorId];
  let hash = 0;
  for (let i = 0; i < connectorId.length; i += 1) hash = (hash * 31 + connectorId.charCodeAt(i)) % 360;
  return `hsl(${hash}, 52%, 52%)`;
}
