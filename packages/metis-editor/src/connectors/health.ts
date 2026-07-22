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
 * Shared connection-health vocabulary: the one status-to-label map, the one
 * "could not test" verdict, and the one testing-state machine every surface
 * (page, picker, connect/edit forms) uses to run a health check.
 */
import { useState } from 'react';
import { type ConnectionHealth } from '../api.js';

export type HealthState = ConnectionHealth | 'testing' | undefined;

export const HEALTH_LABEL: Record<ConnectionHealth['status'], string> = {
  ok: 'Active',
  auth_failed: 'Auth failed',
  unreachable: 'Unreachable',
  error: 'Error',
};

/** The verdict when the test call itself failed (network, server down). */
export const COULD_NOT_TEST: ConnectionHealth = {
  status: 'error',
  ok: false,
  message: 'could not test',
  checkedAt: '',
};

/** Health-test state machine: undefined -> testing -> verdict. */
export function useConnectionTest() {
  const [health, setHealth] = useState<HealthState>();
  const test = async (run: () => Promise<ConnectionHealth>) => {
    setHealth('testing');
    try {
      setHealth(await run());
    } catch {
      setHealth(COULD_NOT_TEST);
    }
  };
  return { health, setHealth, test };
}
