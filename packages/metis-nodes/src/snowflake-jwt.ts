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
 * Snowflake key-pair authentication. The SQL REST API does not accept a
 * password: it takes an OAuth token or a JWT signed with the private half of a
 * key pair whose public half is set on the Snowflake user. So a Snowflake
 * connection stores a private key, not a secret string, and every request
 * carries a short-lived token minted here.
 *
 * Written against node:crypto rather than a JWT library: this is three base64url
 * segments and one RSA-SHA256 signature, and an Apache-2.0 build is better off
 * without another dependency in the trust path.
 */
import { createHash, createPrivateKey, createPublicKey, createSign } from 'node:crypto';

/** How long a minted token stays valid. Snowflake caps this at one hour. */
export const JWT_LIFETIME_SECONDS = 55 * 60;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

/**
 * The account identifier as the JWT wants it: uppercase, and without the region
 * and cloud suffix. `abc12345.eu-west-1.aws` is the host's name for the account;
 * the token wants plain `ABC12345`. An org-account identifier
 * (`myorg-myaccount`) carries no dot and passes through untouched.
 */
export function jwtAccount(account: string): string {
  return account.split('.')[0]!.toUpperCase();
}

/**
 * Snowflake identifies the key by a fingerprint of its PUBLIC half: the base64
 * SHA-256 of the DER-encoded SubjectPublicKeyInfo. Derived from the private key
 * so a connection never has to store both.
 */
export function publicKeyFingerprint(privateKeyPem: string, passphrase?: string): string {
  const privateKey = createPrivateKey(
    passphrase ? { key: privateKeyPem, passphrase } : { key: privateKeyPem },
  );
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
}

export interface SnowflakeJwtInput {
  account: string;
  user: string;
  privateKey: string;
  passphrase?: string;
  /** Injected so the token is reproducible under test. */
  nowSeconds?: number;
}

/** Mint a bearer token for the SQL API. */
export function snowflakeJwt(input: SnowflakeJwtInput): string {
  const account = jwtAccount(input.account);
  const user = input.user.toUpperCase();
  const qualified = `${account}.${user}`;
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: `${qualified}.${publicKeyFingerprint(input.privateKey, input.passphrase)}`,
      sub: qualified,
      iat: issuedAt,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const key = input.passphrase
    ? { key: input.privateKey, passphrase: input.passphrase }
    : { key: input.privateKey };
  return `${header}.${payload}.${base64url(signer.sign(key))}`;
}
