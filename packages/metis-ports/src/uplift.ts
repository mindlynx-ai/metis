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
 * The uplift client surface: the one small, versioned integration point
 * through which the open build reaches a Helix cloud (or the in-repo stub).
 * Three clients - capability gateway, offers, entitlements - sharing one
 * posture: bearer-authed where personal, anonymous where public (offers,
 * per the privacy rule: no per-user data on that call), and fail closed on
 * anything unexpected. Nothing here runs without explicit configuration.
 */

import type { ConnectorCredentialStore } from './credential-port.js';

/** The wire contract this build speaks; the gateway echoes it per response. */
export const HELIX_CONTRACT_VERSION = '1';

/** The reserved vault connection holding the linked Helix account's bearer. */
export const HELIX_ACCOUNT_CONNECTOR_ID = 'helix-account';

/** The OIDC discovery document (the fields this build needs from it). */
export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, Promise<OidcDiscoveryDocument>>();

/**
 * Ceiling on the two calls to the identity server (discovery, and the refresh
 * exchange). Both are small round trips to a service that either answers
 * promptly or is not answering, and both sit under something a person is
 * waiting on: a browser mid-redirect, or a bearer the gateway needs before it
 * can make its own call. Ten seconds is the same ceiling the gateway gives
 * itself, deliberately, because a hung identity server used to be indefinite.
 */
const IDENTITY_TIMEOUT_MS = 10_000;

/**
 * Fetch (once per issuer, cached) the OIDC discovery document. Endpoints
 * must ALWAYS come from here - real Keycloak lives under
 * /realms/<realm>/protocol/openid-connect/*, so paths are never assumed.
 */
export function discoverOidc(identityUrl: string): Promise<OidcDiscoveryDocument> {
  const cached = discoveryCache.get(identityUrl);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(`${identityUrl}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`discovery responded ${response.status}`);
    return (await response.json()) as OidcDiscoveryDocument;
  })();
  discoveryCache.set(identityUrl, pending);
  // A transient failure must not poison the cache forever.
  pending.catch(() => discoveryCache.delete(identityUrl));
  return pending;
}

export interface HelixAccountBearerOptions {
  /** The OIDC issuer base; the token endpoint is resolved from its discovery document. */
  identityUrl: string;
  clientId?: string;
}

/** Refresh this far ahead of the stored expiry. */
const REFRESH_SKEW_MS = 60_000;

/**
 * In-flight refreshes, keyed per account (tenant+issuer+client), shared across
 * the WHOLE process. A refresh must be unique per account, not per getter
 * closure: the runtime builds more than one getter for the same account
 * (control-server entitlements + the cloud gateway). If two closures rotated
 * the same refresh token at once, the second presents an already-rotated token
 * and trips reuse detection, revoking the family and self-inflicting a
 * disconnect. Keying globally collapses them to one rotation.
 */
const inflightRefresh = new Map<string, Promise<string | undefined>>();

/**
 * A bearer getter over the credential vault: finds the reserved account
 * link (if any) and resolves its token. Undefined = not connected; every
 * failure reads as not connected (fail closed).
 *
 * With options set, the getter is rotation-safe: when the stored token
 * nears expiry (or on forceRefresh) it rotates the pair via the discovered
 * token endpoint, single-flighting concurrent callers, and persists the
 * rotated material. A refresh rejected with invalid_grant (rotation reuse
 * detected, or revoked) clears the link entirely: a clean disconnected
 * state, never a half-alive account. Transient failures keep the link.
 */
export function helixAccountBearer(
  credentials: ConnectorCredentialStore,
  tenantId: string,
  options?: HelixAccountBearerOptions,
): (forceRefresh?: boolean) => Promise<string | undefined> {
  const rotate = async (
    connectionId: string,
    refreshToken: string,
    bearerOptions: HelixAccountBearerOptions,
  ): Promise<string | undefined> => {
    let response: Response;
    try {
      const discovery = await discoverOidc(bearerOptions.identityUrl);
      response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: bearerOptions.clientId ?? 'metis',
        }).toString(),
        signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      });
    } catch {
      return undefined; // transient: keep the connection, fail closed for now
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'invalid_grant') {
        // Rotation reuse detected / revoked: fail closed to disconnected.
        await credentials.deleteConnection(tenantId, connectionId).catch(() => undefined);
      }
      return undefined;
    }
    const token = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!token.access_token) return undefined;
    await credentials.updateConnection(tenantId, connectionId, {
      material: {
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        expiresAt: String(Date.now() + (token.expires_in ?? 3600) * 1000),
      },
    });
    return token.access_token;
  };

  return async (forceRefresh = false) => {
    try {
      const link = (await credentials.listConnections(tenantId)).find(
        (connection) => connection.connectorId === HELIX_ACCOUNT_CONNECTOR_ID,
      );
      if (!link) return undefined;
      const material = await credentials.resolveConnectorCredentials(tenantId, link.connectionId);
      const expiresAt = Number(material.expiresAt);
      const stale = forceRefresh || (Number.isFinite(expiresAt) && Date.now() > expiresAt - REFRESH_SKEW_MS);
      if (!stale || !material.refreshToken || !options) return material.accessToken || undefined;
      // Single-flight per account across the whole process (not per closure).
      const key = `${tenantId}\0${options.identityUrl}\0${options.clientId ?? ''}`;
      let flight = inflightRefresh.get(key);
      if (!flight) {
        flight = rotate(link.connectionId, material.refreshToken, options).finally(() => {
          inflightRefresh.delete(key);
        });
        inflightRefresh.set(key, flight);
      }
      return await flight;
    } catch {
      return undefined;
    }
  };
}

/** Routing choice for one dispatch, computed from the workflow + node. */
export interface CapabilityRouting {
  /** The workflow-level "Allow cloud for this workflow" toggle. */
  enabled?: boolean;
  /** Stamped when the user confirmed the consent gate; cloud never binds without it. */
  consentAt?: string;
  /** The per-node "Where it runs" override. */
  nodeMode?: 'local' | 'cloud' | 'auto';
  /** User-set size threshold for 'auto'. There is deliberately no default. */
  thresholdBytes?: number;
}

/**
 * What a purchasable capability costs. Structured rather than baked into the
 * description so changing the price is a data edit in one place, and so the UI
 * can format it per locale later without parsing prose back out.
 *
 * Optional: a gateway that predates this field simply omits it, and a
 * capability that is not yet purchasable has no price to state.
 */
export interface OfferPrice {
  /** Minor units (pence, cents), so no floating point ever touches money. */
  amount: number;
  /** ISO 4217, e.g. GBP. */
  currency: string;
  interval: 'month' | 'year';
}

export interface OfferEntry {
  id: string;
  title: string;
  description: string;
  state: 'coming-soon' | 'beta' | 'available';
  ctaUrl: string;
  message?: string;
  price?: OfferPrice;
  /**
   * What kind of thing this is. A 'step' capability shows up as a node in the
   * builder, so the palette advertises it there. A 'plan' capability is about
   * the shape of the instance (many tenants, a real user directory) and has no
   * step to add - putting one in a step picker reads as nonsense.
   *
   * Absent means 'step', so a gateway that predates this field keeps behaving
   * exactly as it did.
   */
  scope?: 'step' | 'plan';
  /**
   * What the LOCAL version of this capability does, as the palette's lead-in.
   *
   * It used to be one hardcoded sentence, "Works here with smaller data.",
   * which is true of the data capability and of nothing else. A webhook's local
   * limit is not size, it is REACH: the address works on this computer and
   * nowhere else. A capability that cannot state its own limitation gets
   * described by whichever one was written first.
   *
   * Absent keeps the original sentence, so a gateway that predates this field
   * reads exactly as it did.
   */
  local?: string;
  /**
   * What to say once the account IS entitled. The data capability points at the
   * step's own settings ("choose where this step runs"); a webhook has no such
   * switch - its public address simply exists. Absent keeps the original.
   */
  entitledHint?: string;
}

/**
 * Render a price the way the storefront states it. Kept beside the type so the
 * gateway, the offline manifest and the editor cannot drift into three
 * different spellings of the same nine pounds.
 */
export function formatOfferPrice(price: OfferPrice): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
  const symbol = symbols[price.currency] ?? `${price.currency} `;
  const major = price.amount / 100;
  // Whole amounts read better without the trailing zeroes: 9, not 9.00.
  const shown = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return `${symbol}${shown}/${price.interval}`;
}

export type CloudJobStatus = 'accepted' | 'running' | 'done' | 'failed' | 'cancelled';

export interface CloudJob {
  status: CloudJobStatus;
  result?: unknown;
  /** Large results come back as a reference manifest, never inline bytes. */
  manifest?: unknown;
  error?: string;
}

/** The account is not entitled to this capability; carries the upgrade offer. */
export class UnentitledError extends Error {
  constructor(public readonly offer?: OfferEntry) {
    super('This capability needs a Helix plan that includes it.');
    this.name = 'UnentitledError';
  }
}

/** The gateway speaks a different contract version; fail closed, clearly. */
export class ContractMismatchError extends Error {
  constructor(got: string | null) {
    super(
      `The cloud gateway speaks contract version ${got ?? 'unknown'}; this build speaks ${HELIX_CONTRACT_VERSION}. Update Metis to continue.`,
    );
    this.name = 'ContractMismatchError';
  }
}

/** Network failure, timeout or 5xx - the trigger for the degraded local bind. */
export class GatewayUnreachableError extends Error {
  constructor(cause?: unknown) {
    super('The cloud gateway could not be reached.', { cause });
    this.name = 'GatewayUnreachableError';
  }
}

/**
 * The gateway refused THIS request: a 400 whose message names what about the
 * step the cloud cannot do (a reference it can open but not filter, a shape it
 * cannot express, a write attempted through a reference).
 *
 * Separate from unreachable because the diagnosis is the opposite one. The cloud
 * answered, promptly and clearly, and its answer is written for whoever has to
 * change the step; mapping it to unreachable told that person to check their
 * network and threw away the only sentence that would have helped. It still
 * triggers the same degraded local bind - the local backend can do what the
 * cloud refused - but under its own words.
 */
export class GatewayRefusedError extends Error {
  constructor(reason?: string) {
    // A 400 with no readable reason should still not read as a network fault.
    super(reason?.trim() || 'The cloud gateway refused this step.');
    this.name = 'GatewayRefusedError';
  }
}

interface BearerOptions {
  baseUrl: string;
  /**
   * Resolves the cloud bearer (from the credential vault); undefined = not
   * connected. Called with true to force one refresh after a 401.
   */
  getBearer: (forceRefresh?: boolean) => Promise<string | undefined>;
  timeoutMs?: number;
}

/** Every call this file makes to the cloud, bearer resolution included. */
const CLOUD_TIMEOUT_MS = 10_000;

/**
 * Resolve the bearer INSIDE a deadline.
 *
 * Both clients used to await getBearer before the fetch, OUTSIDE the
 * AbortSignal.timeout they otherwise apply, and resolving a bearer can itself
 * reach the identity server (it rotates a near-expiry token). So a hung
 * identity server hung every gateway call and every entitlements read
 * indefinitely, despite the ceiling this file appears to have everywhere.
 *
 * The bound is per phase rather than one budget for the whole call, so a slow
 * pair costs two ceilings. Two ceilings is a number; the previous behaviour was
 * not. It fails as unreachable, which is what both callers already handle: the
 * capability resolver degrades to the local backend, and the entitlements cache
 * falls closed to the empty set.
 */
async function bearerWithin(
  options: BearerOptions,
  forceRefresh?: boolean,
): Promise<string | undefined> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? CLOUD_TIMEOUT_MS);
  return await Promise.race([
    options.getBearer(forceRefresh),
    new Promise<never>((_resolve, reject) => {
      deadline.addEventListener('abort', () =>
        reject(new GatewayUnreachableError(new Error('resolving the cloud bearer timed out'))),
      );
    }),
  ]);
}

/**
 * The capability gateway client (spec section 4.4): invoke returns an
 * accepted job handle; job() polls it to terminal; cancel() is best-effort.
 */
export class CapabilityGatewayClient {
  constructor(private readonly options: BearerOptions) {}

  async invoke(capability: string, body: unknown): Promise<{ jobId: string; status: 'accepted' }> {
    const response = await this.request(`/v1/capabilities/${capability}/invoke`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return (await response.json()) as { jobId: string; status: 'accepted' };
  }

  async job(jobId: string): Promise<CloudJob> {
    const response = await this.request(`/v1/jobs/${jobId}`);
    return (await response.json()) as CloudJob;
  }

  async cancel(jobId: string): Promise<void> {
    await this.request(`/v1/jobs/${jobId}/cancel`, { method: 'POST' });
  }

  private async attempt(
    path: string,
    init: { method?: string; body?: string } | undefined,
    bearer: string | undefined,
  ): Promise<Response> {
    try {
      return await fetch(`${this.options.baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: {
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? CLOUD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GatewayUnreachableError(error);
    }
  }

  private async request(path: string, init?: { method?: string; body?: string }): Promise<Response> {
    const bearer = await bearerWithin(this.options);
    let response = await this.attempt(path, init, bearer);
    // 401 with a bearer attached: force ONE refresh and retry once. A 403
    // is an entitlement gap a refresh cannot fix, so it never retries.
    if (response.status === 401 && bearer) {
      const refreshed = await bearerWithin(this.options, true);
      if (refreshed) response = await this.attempt(path, init, refreshed);
    }
    const contract = response.headers.get('x-helix-contract');
    if (contract !== HELIX_CONTRACT_VERSION) throw new ContractMismatchError(contract);
    if (response.status === 401 || response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { offer?: OfferEntry };
      throw new UnentitledError(body.offer);
    }
    // A 400 is the gateway refusing this step, and its body carries the reason
    // written for whoever has to fix it. Read the same way 401/403 reads its
    // offer: the one field worth keeping, off the body, into a typed error. It
    // used to fall through to unreachable below, which reported a precise,
    // actionable refusal as a network problem.
    if (response.status === 400) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new GatewayRefusedError(body.error);
    }
    if (!response.ok) throw new GatewayUnreachableError(new Error(`gateway responded ${response.status}`));
    return response;
  }
}

const OFFERS_TTL_MS = 60_000;

/** Anonymous, cacheable; callers fall back to a static manifest when it throws. */
export class OffersClient {
  private cache?: { at: number; offers: OfferEntry[] };

  constructor(private readonly options: { baseUrl: string; timeoutMs?: number; ttlMs?: number }) {}

  async offers(): Promise<OfferEntry[]> {
    const ttl = this.options.ttlMs ?? OFFERS_TTL_MS;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.offers;
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/v1/offers`, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw new GatewayUnreachableError(error);
    }
    if (!response.ok) throw new GatewayUnreachableError(new Error(`offers responded ${response.status}`));
    const body = (await response.json()) as { capabilities: OfferEntry[] };
    this.cache = { at: Date.now(), offers: body.capabilities };
    return body.capabilities;
  }
}

export interface CloudAccount {
  email?: string;
}

/**
 * Short-TTL entitlements cache. FAIL CLOSED: any failure - no bearer, bad
 * bearer, network, 5xx - reads as the empty set, never as entitled.
 */
export class CloudEntitlementsClient {
  private cache?: { at: number; capabilities: Set<string>; account?: CloudAccount };

  constructor(private readonly options: BearerOptions & { ttlMs?: number }) {}

  async capabilities(): Promise<Set<string>> {
    return (await this.load()).capabilities;
  }

  async account(): Promise<CloudAccount | undefined> {
    return (await this.load()).account;
  }

  /** Drop the cache (after connect/disconnect) so the next read is live. */
  invalidate(): void {
    this.cache = undefined;
  }

  private fetchEntitlements(bearer: string): Promise<Response> {
    return fetch(`${this.options.baseUrl}/v1/entitlements`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });
  }

  private async load(): Promise<{ capabilities: Set<string>; account?: CloudAccount }> {
    const ttl = this.options.ttlMs ?? 60_000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache;
    try {
      const bearer = await bearerWithin(this.options);
      if (!bearer) {
        this.cache = { at: Date.now(), capabilities: new Set() };
        return this.cache;
      }
      let response = await this.fetchEntitlements(bearer);
      // 401 with a bearer attached: force ONE refresh, retry once, then
      // fall through to the fail-closed catch as today.
      if (response.status === 401) {
        const refreshed = await bearerWithin(this.options, true);
        if (refreshed) response = await this.fetchEntitlements(refreshed);
      }
      if (!response.ok) throw new Error(`entitlements responded ${response.status}`);
      const body = (await response.json()) as { account?: CloudAccount; entitlements?: string[] };
      this.cache = { at: Date.now(), capabilities: new Set(body.entitlements ?? []), account: body.account };
    } catch {
      this.cache = { at: Date.now(), capabilities: new Set() };
    }
    return this.cache;
  }
}
