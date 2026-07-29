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
 * SigV4 against AWS's own published vectors, one stage at a time.
 *
 * The vectors are from the AWS SigV4 test suite (the `get-vanilla` case, whose
 * files carry the canonical request, the string to sign and the authorization
 * header) and from the signing-key derivation worked through in the AWS docs.
 * Both use the published example identity AKIDEXAMPLE / wJalrXUtnFEMI...
 *
 * Every stage is pinned separately on purpose. A signature is a hash of a hash
 * of a document: get one newline wrong anywhere and the only symptom is a 403
 * that says nothing. Pinned in stages, the failing test names the mistake.
 */
import { describe, expect, it } from 'vitest';
import {
  amzDates,
  canonicalQuery,
  canonicalRequest,
  canonicalUrl,
  credentialScope,
  encodeKeyPath,
  encodeRfc3986,
  presignUrl,
  sha256Hex,
  sign,
  signRequest,
  signingKey,
  stringToSign,
  EMPTY_PAYLOAD_SHA256,
} from '../sigv4.js';

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  // The published example secret; it authenticates nothing anywhere.
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const DATE = new Date('2015-08-30T12:36:00Z');

describe('SigV4 stage by stage, against the AWS test-suite vectors', () => {
  const url = new URL('https://example.amazonaws.com/');
  const headers = { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' };

  it('hashes an empty payload the way every no-body request must', () => {
    expect(EMPTY_PAYLOAD_SHA256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('stage 1: builds get-vanilla canonical request byte for byte', () => {
    const { text, signedHeaders } = canonicalRequest('GET', url, headers, EMPTY_PAYLOAD_SHA256);
    expect(text).toBe(
      'GET\n' +
        '/\n' +
        '\n' +
        'host:example.amazonaws.com\n' +
        'x-amz-date:20150830T123600Z\n' +
        '\n' +
        'host;x-amz-date\n' +
        EMPTY_PAYLOAD_SHA256,
    );
    expect(signedHeaders).toBe('host;x-amz-date');
  });

  it('stage 2: builds the string to sign, hashed canonical request and all', () => {
    const { text } = canonicalRequest('GET', url, headers, EMPTY_PAYLOAD_SHA256);
    const scope = credentialScope('20150830', 'us-east-1', 'service');
    expect(scope).toBe('20150830/us-east-1/service/aws4_request');
    expect(stringToSign('20150830T123600Z', scope, text)).toBe(
      'AWS4-HMAC-SHA256\n' +
        '20150830T123600Z\n' +
        '20150830/us-east-1/service/aws4_request\n' +
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    );
  });

  it('stage 3: derives the signing key the AWS docs derive', () => {
    // The worked example in the docs, which uses the iam service.
    expect(signingKey(CREDENTIALS.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  it('stage 4: signs get-vanilla to the published signature', () => {
    const { text } = canonicalRequest('GET', url, headers, EMPTY_PAYLOAD_SHA256);
    const scope = credentialScope('20150830', 'us-east-1', 'service');
    expect(sign(CREDENTIALS, '20150830', 'us-east-1', 'service', stringToSign('20150830T123600Z', scope, text))).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('the encoding rules that quietly break a signature', () => {
  it('escapes the four characters encodeURIComponent leaves behind', () => {
    expect(encodeRfc3986("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af');
    expect(encodeRfc3986('a b/c')).toBe('a%20b%2Fc');
    // Unreserved characters stay literal, or S3 rejects the signature.
    expect(encodeRfc3986('aZ0-_.~')).toBe('aZ0-_.~');
  });

  it('keeps a key its own path, one escaped segment at a time', () => {
    expect(encodeKeyPath('returns/ord 42/photo (1).jpg')).toBe(
      'returns/ord%2042/photo%20%281%29.jpg',
    );
  });

  it('sorts and re-encodes the query, because AWS signs it sorted', () => {
    const url = new URL('https://example.com/?b=2&a=1&a=0&list-type=2');
    expect(canonicalQuery(url)).toBe('a=0&a=1&b=2&list-type=2');
  });

  it('sends the same query it signed, %20 and not +', () => {
    // URLSearchParams would serialise the space as "+" and the star literally.
    const url = new URL('https://example.com/x');
    url.searchParams.set('prefix', 'a b*c');
    expect(url.toString()).toContain('a+b*c');
    expect(canonicalUrl(url)).toBe('https://example.com/x?prefix=a%20b%2Ac');
  });

  it('formats both date forms out of one clock', () => {
    expect(amzDates(DATE)).toEqual({ amzDate: '20150830T123600Z', dateStamp: '20150830' });
  });
});

describe('signing a request for the wire', () => {
  it('carries the scope, the signed headers and the payload hash', () => {
    const headers = signRequest(
      {
        method: 'PUT',
        url: new URL('https://bucket.s3.eu-west-1.amazonaws.com/evidence/photo.jpg'),
        headers: { 'content-type': 'image/jpeg' },
        payloadHash: sha256Hex('bytes'),
        region: 'eu-west-1',
        date: DATE,
      },
      CREDENTIALS,
    );
    expect(headers.authorization).toContain(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-west-1/s3/aws4_request',
    );
    expect(headers.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
    );
    expect(headers['x-amz-content-sha256']).toBe(sha256Hex('bytes'));
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    // The secret is never a header, only ever the key a signature came out of.
    expect(JSON.stringify(headers)).not.toContain(CREDENTIALS.secretAccessKey);
  });

  it('signs a session token when the credentials are temporary', () => {
    const headers = signRequest(
      { method: 'GET', url: new URL('https://b.s3.amazonaws.com/k'), region: 'us-east-1', date: DATE },
      { ...CREDENTIALS, sessionToken: 'session-token' },
    );
    expect(headers['x-amz-security-token']).toBe('session-token');
    expect(headers.authorization).toContain('x-amz-security-token');
  });
});

describe('presigning, which is a pure function of the clock', () => {
  const request = {
    method: 'GET',
    url: new URL('https://metis-sample.s3.eu-west-1.amazonaws.com/returns/photo.jpg'),
    region: 'eu-west-1',
    expiresIn: 900,
    date: DATE,
  };

  it('is deterministic to the byte', () => {
    // Pinned exactly: a presigned URL has no server round trip to catch a
    // change, so drift here would only show up as somebody's 403 later.
    expect(presignUrl(request, CREDENTIALS)).toBe(
      'https://metis-sample.s3.eu-west-1.amazonaws.com/returns/photo.jpg' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Feu-west-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20150830T123600Z' +
        '&X-Amz-Expires=900' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=633b745810cf4261fa950b227d4d538e42492155ea47e1a75238546aec5e35bf',
    );
  });

  it('signs host alone, so a browser can open the link', () => {
    const url = new URL(presignUrl(request, CREDENTIALS));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    // The whole point: the URL carries authorisation, never the secret.
    expect(url.toString()).not.toContain(CREDENTIALS.secretAccessKey);
  });

  it('changes with the clock, the expiry and the method', () => {
    const base = presignUrl(request, CREDENTIALS);
    expect(presignUrl({ ...request, date: new Date('2015-08-30T12:36:01Z') }, CREDENTIALS)).not.toBe(base);
    expect(presignUrl({ ...request, expiresIn: 901 }, CREDENTIALS)).not.toBe(base);
    expect(presignUrl({ ...request, method: 'PUT' }, CREDENTIALS)).not.toBe(base);
  });
});
