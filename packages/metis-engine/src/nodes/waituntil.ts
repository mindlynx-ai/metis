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
 * waituntil wait-time computation, ported from the origin's
 * getWaitTime. Pure and deterministic: relative offsets are static, and
 * the absolute dateFrom mode uses only the caller-supplied now.
 */
export interface WaitUntilConfig {
  dateFrom?: string;
  durationMs?: number;
  waitDays?: string | number;
  waitHours?: string | number;
  waitMinutes?: string | number;
  waitSeconds?: string | number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function getWaitTimeMs(config: unknown, now: number): number {
  if (!config || typeof config !== 'object') return 0;
  const wait = config as WaitUntilConfig;
  if (typeof wait.durationMs === 'number' && wait.durationMs > 0) {
    return wait.durationMs;
  }
  const offsets =
    Number(wait.waitDays ?? 0) * DAY_MS +
    Number(wait.waitHours ?? 0) * HOUR_MS +
    Number(wait.waitMinutes ?? 0) * MINUTE_MS +
    Number(wait.waitSeconds ?? 0) * 1000;
  if (Number.isNaN(offsets) || offsets <= 0) return 0;
  if (wait.dateFrom) {
    const from = Date.parse(wait.dateFrom);
    if (!Number.isNaN(from)) {
      return Math.max(0, from + offsets - now);
    }
  }
  return offsets;
}
