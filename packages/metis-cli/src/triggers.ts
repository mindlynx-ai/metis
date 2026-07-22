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
 * `metis triggers` argument parsing and rendering. Kept pure so the CLI
 * command is a thin adapter over the TriggerService and the whole
 * surface is unit-testable.
 */
import type { TriggerInput, TriggerRecord } from '@mindlynx/metis-orchestrator';
import { renderTable } from './render-table.js';

export interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

export function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** Build a validated TriggerInput from `add <kind> <workflowId> --flags`. */
export function buildTriggerInput(
  kind: string,
  workflowId: string | undefined,
  flags: Record<string, string>,
): TriggerInput {
  if (!workflowId) throw new Error('a workflowId is required');
  if (kind === 'webhook') {
    const verification = (flags.verification ??
      (flags.connector === 'github' ? 'github' : 'hmac')) as TriggerRecord['verification'];
    if (verification !== 'none' && !flags.secret) {
      throw new Error('webhook triggers need --secret (or --verification none)');
    }
    return {
      kind: 'webhook',
      workflowId,
      connectorId: flags.connector,
      event: flags.event,
      verification,
      secret: flags.secret,
    };
  }
  if (kind === 'poll') {
    if (!flags.connector || !flags.operation || !flags.cursor) {
      throw new Error('poll triggers need --connector, --operation and --cursor');
    }
    return {
      kind: 'poll',
      workflowId,
      connectorId: flags.connector,
      event: flags.event,
      operation: flags.operation,
      cursorField: flags.cursor,
      itemsPath: flags.items,
    };
  }
  if (kind === 'schedule') {
    if (!flags.cron) throw new Error('schedule triggers need --cron');
    return { kind: 'schedule', workflowId, cron: flags.cron };
  }
  throw new Error(`unknown trigger kind "${kind}" (expected webhook, poll or schedule)`);
}

function target(record: TriggerRecord): string {
  if (record.kind === 'schedule') return record.cron ?? '';
  const connector = record.connectorId ? `${record.connectorId}` : '(none)';
  return record.event ? `${connector}:${record.event}` : connector;
}

export function formatTriggerList(records: TriggerRecord[]): string {
  const sorted = [...records].sort((a, b) => a.triggerId.localeCompare(b.triggerId));
  const rows = sorted.map((record) => [
    record.triggerId,
    record.kind,
    record.enabled ? 'on' : 'off',
    record.workflowId,
    target(record),
  ]);
  return renderTable(['ID', 'KIND', 'ON', 'WORKFLOW', 'TARGET'], rows);
}
