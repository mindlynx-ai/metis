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
 * Session lifetime: a token used to live until the process restarted, which on
 * a long-running server means forever. Its own file because it mocks
 * node:crypto to count scrypt calls, and that must not leak into the other
 * adapter specs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scryptSync } from 'node:crypto';
import {
  SingleTenantIdentity,
  DEFAULT_SESSION_POLICY,
  type SessionPolicy,
} from '../single-tenant-identity.js';

// The real thing, wrapped so the test can count how much hashing a sign-in
// costs. Everything else in node:crypto stays actual.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scryptSync: vi.fn(actual.scryptSync) };
});

const SEEDS = [{ userId: 'jeremy', secret: 'pw', role: 'admin' as const }];
const HOUR = 3_600_000;

async function signedIn(policy?: Partial<SessionPolicy>) {
  const identity = await SingleTenantIdentity.create('t1', SEEDS, policy);
  const session = await identity.authenticate('jeremy', 'pw');
  return { identity, token: identity.issueToken(session!) };
}

describe('session lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a token past its absolute window however busy the session was', async () => {
    const { identity, token } = await signedIn({ absoluteHours: 2, idleHours: 1 });

    // Used every half hour up to 90 minutes, so the idle window never bites
    // and the session stays inside the absolute one.
    for (let elapsed = 0; elapsed < 3; elapsed += 1) {
      vi.advanceTimersByTime(HOUR / 2);
      expect(await identity.verify(token)).toBeDefined();
    }

    // Crossing 2 hours ends it anyway, or "active" would mean "forever".
    vi.advanceTimersByTime(HOUR / 2);
    expect(await identity.verify(token)).toBeUndefined();
  });

  it('refuses a token idle past the window, well inside the absolute one', async () => {
    const { identity, token } = await signedIn({ absoluteHours: 24, idleHours: 1 });

    vi.advanceTimersByTime(HOUR / 2);
    expect(await identity.verify(token)).toBeDefined();

    // Silence past the idle window ends it, with 22 hours of absolute left.
    vi.advanceTimersByTime(HOUR + 1);
    expect(await identity.verify(token)).toBeUndefined();
  });

  it('refuses a revoked token immediately, with no clock movement at all', async () => {
    const { identity, token } = await signedIn();
    expect(await identity.verify(token)).toBeDefined();

    identity.revoke(token);
    expect(await identity.verify(token)).toBeUndefined();
  });

  it('expires by default, so an operator who never reads the config still has a window', async () => {
    expect(DEFAULT_SESSION_POLICY.absoluteHours).toBeLessThanOrEqual(24);
    expect(DEFAULT_SESSION_POLICY.idleHours).toBeLessThan(DEFAULT_SESSION_POLICY.absoluteHours);

    const { identity, token } = await signedIn();
    vi.advanceTimersByTime(DEFAULT_SESSION_POLICY.absoluteHours * HOUR + 1);
    expect(await identity.verify(token)).toBeUndefined();
  });

  it('caps the live session map, dropping the oldest rather than growing', async () => {
    const identity = await SingleTenantIdentity.create('t1', SEEDS, { maxSessions: 3 });
    const session = await identity.authenticate('jeremy', 'pw');
    const tokens = Array.from({ length: 5 }, () => identity.issueToken(session!));

    expect(identity.sessionCount).toBeLessThanOrEqual(3);
    expect(await identity.verify(tokens[0])).toBeUndefined();
    expect(await identity.verify(tokens[1])).toBeUndefined();
    expect(await identity.verify(tokens[4])).toBeDefined();
  });

  it('sweeps expired sessions, so tokens issued and abandoned cannot pile up', async () => {
    const identity = await SingleTenantIdentity.create('t1', SEEDS, { absoluteHours: 1 });
    const session = await identity.authenticate('jeremy', 'pw');
    for (let i = 0; i < 3; i += 1) identity.issueToken(session!);
    expect(identity.sessionCount).toBe(3);

    // Never verified, so only a sweep can clear them. The next sign-in is the
    // only thing that grows the map, so it is the only place that has to.
    vi.advanceTimersByTime(2 * HOUR);
    identity.issueToken(session!);
    expect(identity.sessionCount).toBe(1);
  });

  it('charges an unknown username the same hashing as a known one', async () => {
    const identity = await SingleTenantIdentity.create('t1', SEEDS);
    const hash = vi.mocked(scryptSync);

    // A count, not a stopwatch: the leak was that a miss returned BEFORE
    // scrypt ran, so a miss cost nothing. Counting the calls proves the same
    // work is done on both paths without a wall-clock assertion that would
    // flake on a loaded machine.
    hash.mockClear();
    expect(await identity.authenticate('nobody', 'pw')).toBeUndefined();
    const miss = hash.mock.calls.length;

    hash.mockClear();
    expect(await identity.authenticate('jeremy', 'pw')).toBeDefined();
    const hit = hash.mock.calls.length;

    expect(miss).toBe(hit);
    expect(miss).toBeGreaterThan(0);
  });
});
