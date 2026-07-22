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

/** Time formatting shared by the run surfaces (Operate, per-workflow runs). */

/** "3m ago" for fresh runs, a locale date once it is old news. */
export function timeAgo(iso: string | undefined, now: number): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '-';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** "in 3m" for near-future times, a locale stamp when it is far off. */
export function timeUntil(iso: string | undefined, now: number): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '-';
  const seconds = Math.round((then - now) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)}h`;
  return new Date(iso).toLocaleString();
}

/** "2.3s" between start and close, when both exist. */
export function durationBetween(start?: string, close?: string): string | undefined {
  if (!start || !close) return undefined;
  const ms = new Date(close).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
