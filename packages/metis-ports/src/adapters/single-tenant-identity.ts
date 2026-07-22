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

interface StoredUser {
  userId: string;
  salt: Buffer;
  hash: Buffer;
  role: Role;
}

/**
 * The open default IdentityPort: one tenant, basic multi-user,
 * simple roles. Secrets are scrypt-hashed with per-user salts and
 * compared in constant time; tokens are opaque in-process session ids.
 */
export class SingleTenantIdentity implements IdentityPort {
  private readonly sessions = new Map<string, Session>();

  private constructor(
    private readonly tenantId: string,
    private readonly users: StoredUser[],
  ) {}

  static create(tenantId: string, seeds: UserSeed[]): Promise<SingleTenantIdentity> {
    const users = seeds.map((seed) => {
      const salt = randomBytes(16);
      return {
        userId: seed.userId,
        salt,
        hash: scryptSync(seed.secret, salt, 32),
        role: seed.role,
      };
    });
    return Promise.resolve(new SingleTenantIdentity(tenantId, users));
  }

  authenticate(userId: string, secret: string): Promise<Session | undefined> {
    const user = this.users.find((candidate) => candidate.userId === userId);
    if (!user) return Promise.resolve(undefined);
    const attempt = scryptSync(secret, user.salt, 32);
    if (!timingSafeEqual(attempt, user.hash)) return Promise.resolve(undefined);
    return Promise.resolve({ userId: user.userId, tenantId: this.tenantId, role: user.role });
  }

  issueToken(session: Session): string {
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, session);
    return token;
  }

  verify(token: string): Promise<Session | undefined> {
    return Promise.resolve(this.sessions.get(token));
  }

  can(session: Session, action: Action): boolean {
    if (action === 'view') return true;
    if (action === 'edit') return session.role === 'admin' || session.role === 'editor';
    return session.role === 'admin';
  }
}
