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
 * What binding a webhook tells you. The warning is the point: a loopback URL
 * pasted into a provider's dashboard can never be called, and the trigger
 * looks perfectly healthy while that is true.
 */
import { describe, it, expect } from 'vitest';
import { webhookHint, webhookUrl } from '../webhook-address.js';

const TRIGGER = 'trg_1234';

describe('the webhook address', () => {
  it('is a full URL, not a bare path', () => {
    expect(webhookUrl('http://localhost:3000', TRIGGER)).toBe('http://localhost:3000/hooks/trg_1234');
  });

  it('does not double the slash when the origin carries one', () => {
    expect(webhookUrl('https://hooks.example.com/', TRIGGER)).toBe('https://hooks.example.com/hooks/trg_1234');
  });

  for (const origin of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://metis.localhost:3000',
  ]) {
    it(`warns that ${origin} is reachable from this machine only`, () => {
      const hint = webhookHint(origin, TRIGGER);
      expect(hint).toContain(`${origin}/hooks/trg_1234`);
      expect(hint).toContain('THIS MACHINE ONLY');
      // Naming the way out matters as much as naming the problem.
      expect(hint).toMatch(/tunnel|ngrok|cloudflared/);
    });
  }

  for (const origin of ['https://metis.example.com', 'http://192.168.1.20:3000', 'https://hooks.acme.io:8443']) {
    it(`does not warn about ${origin}, which a sender can reach`, () => {
      const hint = webhookHint(origin, TRIGGER);
      expect(hint).toBe(`POST to ${origin}/hooks/trg_1234`);
      expect(hint).not.toContain('THIS MACHINE');
    });
  }

  it('still answers when the origin is not a parseable URL', () => {
    expect(webhookHint('not a url', TRIGGER)).toContain('/hooks/trg_1234');
  });
});
