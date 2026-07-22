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
import { describe, it, expect } from 'vitest';
import { SelfHealing } from '../self-heal.js';

describe('withSelfHeal (ported hardening)', () => {
  it('rebuilds the client on a stale-channel error and retries once', async () => {
    let built = 0;
    const healer = new SelfHealing(async () => {
      built += 1;
      const generation = built;
      return {
        call: async () => {
          if (generation === 1) {
            throw new Error('14 UNAVAILABLE: Channel has been shut down');
          }
          return `ok from client ${generation}`;
        },
      };
    });
    const result = await healer.withSelfHeal((client) => client.call());
    expect(result).toBe('ok from client 2');
    expect(built).toBe(2);
  });

  it('does not rebuild on ordinary application errors', async () => {
    let built = 0;
    const healer = new SelfHealing(async () => {
      built += 1;
      return {
        call: async () => {
          throw new Error('workflow not found');
        },
      };
    });
    await expect(healer.withSelfHeal((client) => client.call())).rejects.toThrow(/not found/);
    expect(built).toBe(1);
  });

  it('reuses the same client across calls', async () => {
    let built = 0;
    const healer = new SelfHealing(async () => {
      built += 1;
      return { call: async () => built };
    });
    await healer.withSelfHeal((client) => client.call());
    await healer.withSelfHeal((client) => client.call());
    expect(built).toBe(1);
  });
});
