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
 * The failed-sign-in throttle for POST /api/auth/login, which had none.
 *
 * Keyed on source address AND username together, the least bad of the three
 * obvious choices. Address alone punishes everyone behind one NAT or proxy for
 * one person's typing. Username alone hands any stranger a lockout of any
 * account they can name. The pair means a single address runs out of guesses
 * against a single account, while the account's real owner - a different
 * address, a different bucket - can still sign in.
 *
 * Only FAILURES count and a success clears the bucket: the thing worth
 * metering is guessing, not an operator's script signing in correctly fifty
 * times an hour.
 *
 * What it does not stop, in one place so it is not a surprise later:
 * - A distributed attack. Every fresh source address gets a fresh allowance.
 * - Anything much, if Metis runs behind a reverse proxy without Fastify's
 *   trustProxy: request.ip is then the proxy's address for everybody, the
 *   address half of the key collapses to a constant, and this degrades to a
 *   per-account limit - which an attacker CAN use to lock a user out.
 * - An attacker sharing the victim's address, who can spend guesses and then
 *   have the count cleared by the victim's own successful sign-in.
 * - Credential stuffing that gets it right first time. One attempt is one
 *   attempt.
 * - CPU exhaustion by an attacker with valid credentials, since successes are
 *   not metered and each sign-in costs a scrypt.
 * It is per process and in memory, so a restart forgives everyone and two
 * Metis processes do not share a count.
 */

export interface LoginLimitPolicy {
  /** Failures allowed per window, per address+username pair. */
  attempts: number;
  /** How long the window lasts. */
  windowMinutes: number;
}

/** 10 failures per 15 minutes: far above anyone's honest fumbling, far below
 *  a rate at which guessing a 24-byte secret is worth starting. */
export const DEFAULT_LOGIN_LIMIT: LoginLimitPolicy = { attempts: 10, windowMinutes: 15 };

interface Window {
  count: number;
  resetAt: number;
}

export class LoginRateLimit {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;

  constructor(private readonly policy: LoginLimitPolicy = DEFAULT_LOGIN_LIMIT) {
    this.windowMs = policy.windowMinutes * 60_000;
  }

  /** NUL joins the halves: it cannot appear in either, so no address and
   *  username can be arranged to collide with another pair. */
  private static key(address: string, userId: string): string {
    return `${address}\u0000${userId}`;
  }

  /** True when this pair has spent its guesses and has to wait. */
  blocked(address: string, userId: string): boolean {
    const window = this.windows.get(LoginRateLimit.key(address, userId));
    if (!window) return false;
    if (Date.now() >= window.resetAt) return false;
    return window.count >= this.policy.attempts;
  }

  fail(address: string, userId: string): void {
    // The only path that grows the map, so it is the only place the sweep has
    // to run. The map is bounded by what one window's worth of failures can
    // reach, and each one costs a scrypt, so it cannot run away.
    this.sweep();
    const key = LoginRateLimit.key(address, userId);
    const now = Date.now();
    const window = this.windows.get(key);
    if (!window || now >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    window.count += 1;
  }

  succeed(address: string, userId: string): void {
    this.windows.delete(LoginRateLimit.key(address, userId));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
  }
}
