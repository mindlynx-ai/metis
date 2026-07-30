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

  // The whole bug: a rejected promise is not undefined, so `??=` kept it. One
  // dev Temporal a second slow to accept gRPC poisoned every start, cancel,
  // list and schedule for the life of the process.
  it('does not cache a failed build: the next call builds again', async () => {
    let built = 0;
    const healer = new SelfHealing(async () => {
      built += 1;
      if (built === 1) throw new Error('ECONNREFUSED 127.0.0.1:7233');
      return { call: async () => 'ok' };
    });
    await expect(healer.withSelfHeal((client) => client.call())).rejects.toThrow(/ECONNREFUSED/);
    expect(await healer.withSelfHeal((client) => client.call())).toBe('ok');
    expect(built).toBe(2);
  });

  // The await sat outside the try, so the one path that can heal a bad connect
  // never saw one.
  it('heals a build that fails with a stale-channel signature', async () => {
    let built = 0;
    const healer = new SelfHealing(async () => {
      built += 1;
      if (built === 1) throw new Error('14 UNAVAILABLE: connection refused');
      return { call: async () => 'ok from client 2' };
    });
    expect(await healer.withSelfHeal((client) => client.call())).toBe('ok from client 2');
    expect(built).toBe(2);
  });

  it('closes the client it is dropping, so a heal does not leak a channel', async () => {
    const closed: number[] = [];
    let built = 0;
    const healer = new SelfHealing(
      async () => {
        built += 1;
        const generation = built;
        return {
          generation,
          call: async () => {
            if (generation === 1) throw new Error('14 UNAVAILABLE: Channel has been shut down');
            return 'ok';
          },
        };
      },
      (client) => {
        closed.push(client.generation);
      },
    );
    expect(await healer.withSelfHeal((client) => client.call())).toBe('ok');
    expect(closed).toEqual([1]);
    await healer.reset();
    expect(closed).toEqual([1, 2]);
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
