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
 * `metis webhooks` argument parsing and rendering for outbound signed
 * webhooks. Pure, so the CLI command stays a thin adapter over the
 * OutboundWebhookService.
 */
import type { OutboundWebhookInput, OutboundWebhookRecord } from '@mindlynx/metis-orchestrator';
import { renderTable } from './render-table.js';

const EVENT_ALIASES: Record<string, string> = {
  started: 'workflow.execution.started',
  completed: 'workflow.execution.completed',
  failed: 'workflow.execution.failed',
  cancelled: 'workflow.execution.cancelled',
};

/** Expand a comma-separated event spec, resolving short aliases. */
export function expandEvents(spec?: string): string[] {
  if (!spec || spec === 'all' || spec === '*') return ['*'];
  const events = spec
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => EVENT_ALIASES[token] ?? token);
  return events.length > 0 ? events : ['*'];
}

export function buildWebhookInput(
  url: string | undefined,
  flags: Record<string, string>,
): OutboundWebhookInput {
  if (!url) throw new Error('a target URL is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('webhook url must be http or https');
  }
  return {
    url,
    events: expandEvents(flags.events),
    secret: flags.secret,
    workflowId: flags.workflow,
  };
}

export function formatWebhookList(records: OutboundWebhookRecord[]): string {
  const sorted = [...records].sort((a, b) => a.webhookId.localeCompare(b.webhookId));
  const rows = sorted.map((record) => [
    record.webhookId,
    record.enabled ? 'on' : 'off',
    record.secret ? 'signed' : 'plain',
    record.events.join(','),
    record.url,
  ]);
  return renderTable(['ID', 'ON', 'SIG', 'EVENTS', 'URL'], rows);
}
