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
 * The parts of the Snowflake adapter that can be proven without an account:
 * the key-pair token, and the translation between Snowflake's column-and-array
 * result shape and the rows a workflow reads. Everything here would be a
 * silent wrong answer rather than an error if it drifted, which is exactly the
 * kind of thing worth pinning.
 */
import { createHash, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jwtAccount, publicKeyFingerprint, snowflakeJwt } from '../snowflake-jwt.js';
import { authFor, bindingsFor, rowsFromResponse, snowflakeHost } from '../snowflake-data-source.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const decode = (segment: string) =>
  JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

describe('snowflake key-pair auth', () => {
  it('drops the region from the account for the token but keeps the case rule', () => {
    // The host is abc12345.eu-west-1.aws...; the token wants plain ABC12345.
    expect(jwtAccount('abc12345.eu-west-1.aws')).toBe('ABC12345');
    // An org-account identifier has no region to strip.
    expect(jwtAccount('myorg-myaccount')).toBe('MYORG-MYACCOUNT');
  });

  it('fingerprints the PUBLIC half of the key, derived from the private one', () => {
    const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const expected = `SHA256:${createHash('sha256').update(der).digest('base64')}`;
    expect(publicKeyFingerprint(privateKey)).toBe(expected);
  });

  it('mints a token Snowflake would accept: right claims, real signature', () => {
    const nowSeconds = 1_785_000_000;
    const token = snowflakeJwt({ account: 'abc12345.eu-west-1', user: 'metis_service', privateKey, nowSeconds });
    const [header, payload, signature] = token.split('.');

    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload!);
    expect(claims.sub).toBe('ABC12345.METIS_SERVICE');
    expect(claims.iss).toBe(`ABC12345.METIS_SERVICE.${publicKeyFingerprint(privateKey)}`);
    expect(claims.iat).toBe(nowSeconds);
    // Snowflake caps a token at an hour; ours must sit inside that.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);

    // Verify against the public key, so a broken signing path cannot pass.
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    const raw = Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(verifier.verify(publicKey, raw)).toBe(true);
  });
});

describe('snowflake result translation', () => {
  it('assembles rows from the column metadata and array data', () => {
    const rows = rowsFromResponse({
      resultSetMetaData: {
        numRows: 2,
        rowType: [
          { name: 'CUSTOMER', type: 'text' },
          { name: 'AMOUNT', type: 'fixed' },
          { name: 'NOTE', type: 'text' },
        ],
      },
      data: [
        ['Ada Lovelace', '129.00', null as unknown as string],
        ['Alan Turing', '59.50', 'second'],
      ],
    });
    // A numeric column comes back off the wire as a string; a workflow
    // comparing it to a number must not silently fail.
    expect(rows[0]).toEqual({ CUSTOMER: 'Ada Lovelace', AMOUNT: 129, NOTE: null });
    expect(rows[1]!.AMOUNT).toBe(59.5);
  });

  it('leaves an unparseable numeric as the text it arrived as', () => {
    const rows = rowsFromResponse({
      resultSetMetaData: { rowType: [{ name: 'ODD', type: 'fixed' }] },
      data: [['not-a-number']],
    });
    expect(rows[0]!.ODD).toBe('not-a-number');
  });

  it('binds parameters positionally with a declared type', () => {
    expect(bindingsFor(['paid', 3, true])).toEqual({
      '1': { type: 'TEXT', value: 'paid' },
      '2': { type: 'FIXED', value: '3' },
      '3': { type: 'BOOLEAN', value: 'true' },
    });
  });
});

describe('snowflake host', () => {
  it('builds the REST host from the account identifier', () => {
    expect(snowflakeHost({ account: 'ABC12345.eu-west-1' })).toBe(
      'https://abc12345.eu-west-1.snowflakecomputing.com',
    );
  });

  it('an explicit account URL wins, for private link', () => {
    expect(snowflakeHost({ account: 'abc', accountUrl: 'https://internal.example.com/' })).toBe(
      'https://internal.example.com',
    );
  });
});

describe('snowflake authentication chooses by what the connection carries', () => {
  it('uses a programmatic access token as-is, signing nothing', () => {
    const auth = authFor({ key: 'k1', material: { account: 'abc', token: 'the-pat' } });
    expect(auth).toEqual({ token: 'the-pat', type: 'PROGRAMMATIC_ACCESS_TOKEN' });
  });

  it('falls back to minting a key-pair JWT when there is no token', () => {
    const auth = authFor({ key: 'k2', material: { account: 'abc', user: 'u', privateKey } });
    expect(auth.type).toBe('KEYPAIR_JWT');
    // A real JWT, not the key echoed back.
    expect(auth.token.split('.')).toHaveLength(3);
  });

  it('prefers the token when a connection somehow carries both', () => {
    // Belt and braces: whichever the operator filled in last, one credential
    // has to win deterministically rather than by accident.
    const auth = authFor({ key: 'k3', material: { account: 'abc', user: 'u', privateKey, token: 'pat' } });
    expect(auth.type).toBe('PROGRAMMATIC_ACCESS_TOKEN');
  });

  it('caches the minted JWT rather than re-signing every call', () => {
    const material = { account: 'abc', user: 'u', privateKey };
    const first = authFor({ key: 'cache-me', material });
    const second = authFor({ key: 'cache-me', material });
    expect(second.token).toBe(first.token);
  });
});
