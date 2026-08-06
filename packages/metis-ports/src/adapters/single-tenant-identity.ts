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
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Action, IdentityPort, Role, Session } from '../identity-port.js';

export interface UserSeed {
  userId: string;
  secret: string;
  role: Role;
}

/**
 * How long a session may live. Metis is self-hosted, so the numbers are the
 * operator's to pick (metis.config.json `auth`) - but the DEFAULTS have to be
 * safe, because "no expiry" is exactly the setting nobody knows they have.
 */
export interface SessionPolicy {
  /** Hard ceiling measured from issue. No amount of use extends it. */
  absoluteHours: number;
  /** Silence that ends a session before the ceiling. */
  idleHours: number;
  /** Ceiling on live sessions, so the map is bounded in memory as well as time. */
  maxSessions: number;
}

/**
 * 24h absolute / 8h idle / 10k sessions.
 *
 * 8 < 24 deliberately: an idle window at or above the absolute one is inert,
 * it can never be the thing that expires a session. 8h is one working day, so
 * the ordinary "signed in at 09:00, still signed in at 17:00" never breaks,
 * and 24h means a stolen token is worth at most a day rather than until the
 * next restart. 10k sessions is roughly 2 MB - far beyond what a single-tenant
 * install ever holds, small enough that a login flood cannot exhaust memory.
 */
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteHours: 24,
  idleHours: 8,
  maxSessions: 10_000,
};

interface StoredUser {
  userId: string;
  salt: Buffer;
  hash: Buffer;
  role: Role;
}

interface LiveSession {
  session: Session;
  /** Absolute deadline, fixed at issue. */
  expiresAt: number;
  /** Moved forward by every successful verify; the idle window runs from here. */
  lastSeen: number;
}

const HOUR_MS = 3_600_000;

function hashSeed(seed: UserSeed): StoredUser {
  const salt = randomBytes(16);
  return { userId: seed.userId, salt, hash: scryptSync(seed.secret, salt, 32), role: seed.role };
}

/**
 * The open default IdentityPort: one tenant, basic multi-user,
 * simple roles. Secrets are scrypt-hashed with per-user salts and
 * compared in constant time; tokens are opaque in-process session ids
 * that expire on an absolute and an idle window.
 */
export class SingleTenantIdentity implements IdentityPort {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly absoluteMs: number;
  private readonly idleMs: number;
  private readonly maxSessions: number;

  private constructor(
    private readonly tenantId: string,
    private readonly users: StoredUser[],
    /**
     * Hashed against when the username is unknown. Its secret is 32 random
     * bytes, so it can never be a real sign-in; it exists only to make a miss
     * cost the same scrypt as a hit.
     */
    private readonly decoy: StoredUser,
    policy: SessionPolicy,
  ) {
    this.absoluteMs = policy.absoluteHours * HOUR_MS;
    this.idleMs = policy.idleHours * HOUR_MS;
    this.maxSessions = policy.maxSessions;
  }

  static create(
    tenantId: string,
    seeds: UserSeed[],
    policy: Partial<SessionPolicy> = {},
  ): Promise<SingleTenantIdentity> {
    const decoy = hashSeed({ userId: '', secret: randomBytes(32).toString('hex'), role: 'viewer' });
    return Promise.resolve(
      new SingleTenantIdentity(tenantId, seeds.map(hashSeed), decoy, {
        ...DEFAULT_SESSION_POLICY,
        ...policy,
      }),
    );
  }

  /** Live sessions held right now. For the memory bound's test, and for anyone
   *  who wants to meter it. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  authenticate(userId: string, secret: string): Promise<Session | undefined> {
    const user = this.users.find((candidate) => candidate.userId === userId);
    // An unknown username hashes against the decoy instead of returning here.
    // The early return made a miss ~orders cheaper than a hit, so response
    // time enumerated valid usernames; both paths now pay one scrypt and one
    // constant-time compare. (The username scan itself is a handful of string
    // compares - noise beside scrypt.)
    const against = user ?? this.decoy;
    const attempt = scryptSync(secret, against.salt, 32);
    const matched = timingSafeEqual(attempt, against.hash);
    if (!user || !matched) return Promise.resolve(undefined);
    return Promise.resolve({ userId: user.userId, tenantId: this.tenantId, role: user.role });
  }

  issueToken(session: Session): string {
    // Issue is the ONLY path that grows the map, so it is the only place a
    // sweep has to run. No interval to schedule, and none to fail to fire.
    this.sweep();
    const now = Date.now();
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, { session, expiresAt: now + this.absoluteMs, lastSeen: now });
    // Still at the cap after sweeping means these are all live: drop the
    // oldest, so a flood of sign-ins costs bounded memory rather than all of it.
    if (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    return token;
  }

  verify(token: string): Promise<Session | undefined> {
    const live = this.sessions.get(token);
    if (!live) return Promise.resolve(undefined);
    const now = Date.now();
    // Checked on USE, not only by the sweep, so a token cannot outlive its
    // window just because nothing has come round to collect it yet.
    if (this.expired(live, now)) {
      this.sessions.delete(token);
      return Promise.resolve(undefined);
    }
    live.lastSeen = now;
    return Promise.resolve(live.session);
  }

  /** Sign out. The map is the only store, so the token is dead on return -
   *  nothing is merely marked for a later sweep. */
  revoke(token: string): void {
    this.sessions.delete(token);
  }

  can(session: Session, action: Action): boolean {
    if (action === 'view') return true;
    if (action === 'edit') return session.role === 'admin' || session.role === 'editor';
    return session.role === 'admin';
  }

  private expired(live: LiveSession, now: number): boolean {
    return now >= live.expiresAt || now - live.lastSeen >= this.idleMs;
  }

  private sweep(): void {
    const now = Date.now();
    // ponytail: a full scan, because it runs only on sign-in and the map is
    // capped. If sign-ins ever became hot, an expiry-ordered heap is the upgrade.
    for (const [token, live] of this.sessions) {
      if (this.expired(live, now)) this.sessions.delete(token);
    }
  }
}
