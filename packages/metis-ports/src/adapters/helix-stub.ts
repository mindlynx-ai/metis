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
 * The in-repo Helix stub: the executable definition of everything the real
 * Helix estate must later provide - /v1/offers, /v1/entitlements, the
 * capability gateway job lifecycle, and a real OIDC surface: discovery at
 * /.well-known/openid-configuration, RS256 id_tokens verifiable against
 * /oidc/jwks (nonce echoed from the authorize request), and rotation-safe
 * refresh tokens with family reuse detection. Contract tests and the fast
 * e2e run against this; nothing in it ships to production paths.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { HELIX_CONTRACT_VERSION, type CloudJob, type OfferEntry } from '../uplift.js';

export const STUB_OFFERS: OfferEntry[] = [
  {
    id: 'cap.data',
    title: 'Big data',
    description: 'Query millions of rows and run heavy transforms in the cloud.',
    state: 'available',
    ctaUrl: 'https://helix.example/plans',
    // The palette's uplift pitch tail ("Full version in the cloud ..."):
    // the manifest owns the marketing line, not the editor.
    message: 'handles millions of rows.',
  },
  {
    id: 'cap.memory',
    title: 'Memory',
    description: 'Give workflows long-term recall.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
  {
    id: 'cap.agent',
    title: 'Agents',
    description: 'Delegate steps to autonomous skills.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
  {
    id: 'cap.approvals',
    title: 'Approvals',
    description: 'Human sign-off gates inside a run.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
  {
    id: 'cap.model',
    title: 'Models',
    description: 'Managed AI models with spending caps.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
];

export interface HelixStubOptions {
  /** Capability ids granted to any authenticated bearer. Default: ['cap.data']. */
  entitled?: string[];
  /** How long an invoked job stays 'running' before it completes. Default 0. */
  jobDelayMs?: number;
  /** Respond with this contract version (mismatch tests). Default '1'. */
  contractVersion?: string;
  /** Complete every job as 'failed' instead of 'done'. */
  failJobs?: boolean;
  /** The account email the OIDC flow reports. */
  email?: string;
  /** expires_in on token responses. Default 3600. */
  accessTtlSeconds?: number;
  /** Claims merged OVER the real id_token claims (negative-path tests). */
  idTokenClaims?: Record<string, unknown>;
  /** Break the id_token signature (negative-path tests). */
  tamperIdTokenSignature?: boolean;
}

export interface HelixStub {
  url: string;
  port: number;
  /** Mint a bearer without the OIDC dance (test convenience). */
  issueToken(email?: string): string;
  /** Kill every live access token (refresh tokens survive): 401-retry tests. */
  revokeAccessTokens(): void;
  /** Job ids that received a cancel call. */
  cancelled: string[];
  /** Per-path request counts (cache assertions). */
  requests: Record<string, number>;
  close(): Promise<void>;
}

const STUB_KID = 'stub-1';

export async function startHelixStub(options: HelixStubOptions = {}, port = 0): Promise<HelixStub> {
  const entitled = new Set(options.entitled ?? ['cap.data']);
  const contract = options.contractVersion ?? HELIX_CONTRACT_VERSION;
  const email = options.email ?? 'user@helix.example';
  const accessTtl = options.accessTtlSeconds ?? 3600;
  const tokens = new Map<string, { email: string; family: string }>();
  const refreshTokens = new Map<string, { email: string; family: string; used?: boolean }>();
  const codes = new Map<string, { email: string; nonce?: string; clientId?: string }>();
  const jobs = new Map<string, CloudJob>();
  const timers: NodeJS.Timeout[] = [];
  const cancelled: string[] = [];
  const requests: Record<string, number> = {};
  // RS256 signing pair; the public half is served at /oidc/jwks.
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let baseUrl = ''; // known after listen; handlers only run after listen

  const issueToken = (forEmail = email, family = `fam_${randomUUID()}`): string => {
    const token = `stub_${randomUUID()}`;
    tokens.set(token, { email: forEmail, family });
    return token;
  };

  const issueTokenPair = (forEmail: string, family: string) => {
    const refreshToken = `refresh_${randomUUID()}`;
    refreshTokens.set(refreshToken, { email: forEmail, family });
    return { accessToken: issueToken(forEmail, family), refreshToken };
  };

  /** Reuse detection: a replayed refresh token kills its whole family. */
  const revokeFamily = (family: string): void => {
    for (const [token, info] of tokens) if (info.family === family) tokens.delete(token);
    for (const info of refreshTokens.values()) if (info.family === family) info.used = true;
  };

  const mintIdToken = (forEmail: string, nonce?: string, forClient?: string): string => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: baseUrl,
      // Faithful to a real IdP: the id_token aud is the client that requested
      // it (from the authorize call), not a fixed value. Falls back to 'metis'
      // for direct token calls that carry no client.
      aud: forClient ?? 'metis',
      sub: `user_${forEmail}`,
      email: forEmail,
      iat: now,
      exp: now + 300,
      ...(nonce ? { nonce } : {}),
      ...options.idTokenClaims,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: STUB_KID })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    let signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url');
    if (options.tamperIdTokenSignature) {
      signature = (signature.endsWith('A') ? 'B' : 'A') + signature.slice(1);
    }
    return `${header}.${payload}.${signature}`;
  };

  const bearerOf = (request: IncomingMessage): { email: string } | undefined => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return tokens.get(token);
  };

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'x-helix-contract': contract });
    response.end(JSON.stringify(body));
  };

  const handleManifest = (request: IncomingMessage, response: ServerResponse, path: string): boolean => {
    if (request.method === 'GET' && path === '/v1/offers') {
      json(response, 200, { capabilities: STUB_OFFERS });
      return true;
    }
    if (request.method === 'GET' && path === '/v1/entitlements') {
      const account = bearerOf(request);
      if (!account) json(response, 401, { error: 'unauthorised' });
      else
        json(response, 200, {
          account: { email: account.email },
          entitlements: [...entitled],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      return true;
    }
    return false;
  };

  const runInvoke = (request: IncomingMessage, response: ServerResponse, capability: string): void => {
    if (!bearerOf(request)) return json(response, 401, { error: 'unauthorised' });
    const capabilityId = `cap.${capability}`;
    if (!entitled.has(capabilityId)) {
      return json(response, 403, {
        error: 'unentitled',
        offer: STUB_OFFERS.find((offer) => offer.id === capabilityId),
      });
    }
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const jobId = `job_${randomUUID()}`;
      if (options.jobDelayMs) {
        jobs.set(jobId, { status: 'running' });
        const timer = setTimeout(() => {
          const job = jobs.get(jobId);
          if (job && job.status === 'running') jobs.set(jobId, finishJob(body, capability));
        }, options.jobDelayMs);
        timer.unref();
        timers.push(timer);
      } else {
        jobs.set(jobId, finishJob(body, capability));
      }
      json(response, 200, { jobId, status: 'accepted' });
    });
  };

  const handleJobs = (request: IncomingMessage, response: ServerResponse, path: string): boolean => {
    const invokeMatch = /^\/v1\/capabilities\/([^/]+)\/invoke$/.exec(path);
    if (request.method === 'POST' && invokeMatch) {
      runInvoke(request, response, invokeMatch[1]);
      return true;
    }
    const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      json(response, job ? 200 : 404, job ?? { error: 'no such job' });
      return true;
    }
    const cancelMatch = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (request.method === 'POST' && cancelMatch) {
      if (!jobs.get(cancelMatch[1])) {
        json(response, 404, { error: 'no such job' });
      } else {
        cancelled.push(cancelMatch[1]);
        jobs.set(cancelMatch[1], { status: 'cancelled' });
        json(response, 200, { status: 'cancelled' });
      }
      return true;
    }
    return false;
  };

  // Discovery + JWKS: real clients must learn every endpoint from here,
  // never assume /oidc/* paths (real Keycloak lives under /realms/...).
  const handleOidcMeta = (request: IncomingMessage, response: ServerResponse, path: string): boolean => {
    if (request.method !== 'GET') return false;
    if (path === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oidc/authorize`,
        token_endpoint: `${baseUrl}/oidc/token`,
        jwks_uri: `${baseUrl}/oidc/jwks`,
      });
      return true;
    }
    if (path === '/oidc/jwks') {
      const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      json(response, 200, { keys: [{ ...jwk, kid: STUB_KID, alg: 'RS256', use: 'sig' }] });
      return true;
    }
    return false;
  };

  /** authorization_code grant: single-use code -> tokens + RS256 id_token. */
  const respondCodeGrant = (response: ServerResponse, params: URLSearchParams): void => {
    const code = params.get('code') ?? '';
    const grant = codes.get(code);
    if (!grant) return json(response, 400, { error: 'invalid_grant' });
    codes.delete(code);
    const pair = issueTokenPair(grant.email, `fam_${randomUUID()}`);
    json(response, 200, {
      access_token: pair.accessToken,
      refresh_token: pair.refreshToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      // Email travels ONLY inside the verified id_token; no convenience field.
      id_token: mintIdToken(grant.email, grant.nonce, grant.clientId),
    });
  };

  /** refresh_token grant: rotates; replaying a rotated token revokes the family. */
  const respondRefreshGrant = (response: ServerResponse, params: URLSearchParams): void => {
    const presented = refreshTokens.get(params.get('refresh_token') ?? '');
    if (!presented) return json(response, 400, { error: 'invalid_grant' });
    if (presented.used) {
      revokeFamily(presented.family);
      return json(response, 400, { error: 'invalid_grant' });
    }
    presented.used = true;
    const pair = issueTokenPair(presented.email, presented.family);
    json(response, 200, {
      access_token: pair.accessToken,
      refresh_token: pair.refreshToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
    });
  };

  // OIDC connect: authorize auto-approves (carrying the nonce into the
  // code) and redirects straight back; token serves both grant types.
  const handleOidc = (request: IncomingMessage, response: ServerResponse, url: URL): boolean => {
    if (request.method === 'GET' && url.pathname === '/oidc/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const code = `code_${randomUUID()}`;
      codes.set(code, {
        email,
        nonce: url.searchParams.get('nonce') ?? undefined,
        clientId: url.searchParams.get('client_id') ?? undefined,
      });
      const location = `${redirect}${redirect.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state)}`;
      response.writeHead(302, { location });
      response.end();
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/oidc/token') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'refresh_token') respondRefreshGrant(response, params);
        else respondCodeGrant(response, params);
      });
      return true;
    }
    return false;
  };

  const server: Server = createServer((request, response) => {
    // The base is only for parsing the path; the stub itself is loopback http.
    const url = new URL(request.url ?? '/', 'https://stub');
    requests[url.pathname] = (requests[url.pathname] ?? 0) + 1;
    if (handleManifest(request, response, url.pathname)) return;
    if (handleJobs(request, response, url.pathname)) return;
    if (handleOidcMeta(request, response, url.pathname)) return;
    if (handleOidc(request, response, url)) return;
    json(response, 404, { error: 'not found' });
  });

  function finishJob(rawBody: string, capability: string): CloudJob {
    if (options.failJobs) return { status: 'failed', error: 'the stub was told to fail this job' };
    let echo: unknown = null;
    try {
      echo = JSON.parse(rawBody);
    } catch {
      /* body stays null */
    }
    return { status: 'done', result: { cloud: true, capability, echo } };
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  baseUrl = `http://127.0.0.1:${boundPort}`;

  return {
    url: baseUrl,
    port: boundPort,
    issueToken,
    revokeAccessTokens: () => tokens.clear(),
    cancelled,
    requests,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
