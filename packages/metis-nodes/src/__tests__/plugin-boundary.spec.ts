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
import { FakeCredentialPort, NodeHandlerRegistry, nodeCtx, nodeOutput } from '@mindlynx/metis-ports';
import { registerOpenNodeHandlers } from '../register.js';

const request = (type: string) => nodeCtx(type, {});

describe('plugin boundary', () => {
  it('registers the open handler set with aliases', () => {
    const registry = registerOpenNodeHandlers(new NodeHandlerRegistry(), {
      credentials: new FakeCredentialPort(),
    });
    for (const type of ['api', 'code', 'data', 'http', 'postgres', 'sendgrid', 'sql', 'transform']) {
      expect(registry.canExecute(type), `expected ${type} to be registered`).toBe(true);
    }
    expect(registry.canExecute('cortex.memory.read')).toBe(false);
  });

  it('an unregistered paid type yields the structured upgrade response', async () => {
    const registry = registerOpenNodeHandlers(new NodeHandlerRegistry(), {
      credentials: new FakeCredentialPort(),
    });
    const result = await registry.execute(request('cortex.memory.read'));
    expect(result.status).toBe(501);
    expect(result.message).toMatch(/not available in this edition/i);
  });

  it('a plugin registration through registerNodeHandler makes the type resolve', async () => {
    const registry = registerOpenNodeHandlers(new NodeHandlerRegistry(), {
      credentials: new FakeCredentialPort(),
    });
    registry.registerNodeHandler('cortex.memory.read', () =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { remembered: true } } }),
    );
    const result = await registry.execute(request('cortex.memory.read'));
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toEqual({ remembered: true });
  });
});
