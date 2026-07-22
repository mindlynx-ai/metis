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
 * The Metis CLI: a tiny, dependency-free command router.
 * `metis init` scaffolds a project; `metis up` and `metis run` land in
 * the following iterations. Output goes through injected writers so the
 * whole surface is unit-testable.
 */
import { cmdMcp } from './mcp.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldProject, DEFAULT_CONFIG, type MetisConfig } from './scaffold.js';
import { MetisRuntime } from './runtime.js';
import { buildControlServer } from './control-server.js';
import {
  seedConnectors,
  seedConnectorsIfEmpty,
  formatConnectorList,
  DEFAULT_TENANT,
} from './connectors.js';
import { parseFlags, buildTriggerInput, formatTriggerList } from './triggers.js';
import { buildWebhookInput, formatWebhookList } from './webhooks.js';

export const HELP_TEXT = `metis: the open-source workflow engine

Usage:
  metis init             Scaffold a project in the current directory
  metis up               Start Temporal, the worker, the control plane and the editor
  metis run <workflow>   Run a single workflow and print its result
  metis connectors seed  Seed the top-100 connector catalogue into this project
  metis connectors list  List the connectors registered in this project
  metis triggers add     Bind a webhook, poll or schedule trigger to a workflow
  metis triggers list    List the triggers in this project
  metis webhooks add     Register an outbound signed webhook on workflow events
  metis webhooks list    List the outbound webhooks in this project
  metis mcp              Serve the Model Context Protocol over stdio (AI tools
                         build + run workflows via METIS_URL, default :3000)
  metis --help           Show this help

Everything runs locally. The first time you run "metis up" the CLI
downloads and manages the Temporal dev server for you, so you never
install Temporal by hand.`;

export interface CliContext {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

async function cmdInit(context: CliContext): Promise<number> {
  const result = scaffoldProject(context.cwd);
  for (const created of result.created) context.stdout(`created ${created}`);
  for (const skipped of result.skipped) context.stdout(`kept ${skipped} (already exists)`);
  if (result.created.length === 0) {
    context.stdout('This project is already initialised.');
  } else {
    context.stdout('');
    context.stdout('Project ready. Next: run "metis up" to start everything.');
  }
  return 0;
}

export async function runCli(argv: string[], context: CliContext): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    context.stdout(HELP_TEXT);
    return 0;
  }

  switch (command) {
    case 'init':
      return cmdInit(context);
    case 'up':
      return cmdUp(context);
    case 'run':
      return cmdRun(context, argv[1]);
    case 'connectors':
      return cmdConnectors(context, argv[1]);
    case 'triggers':
      return cmdTriggers(context, argv.slice(1));
    case 'webhooks':
      return cmdWebhooks(context, argv.slice(1));
    case 'mcp':
      return cmdMcp();
    default:
      context.stderr(`unknown command "${command}"`);
      context.stderr('run "metis --help" to see the available commands');
      return 1;
  }
}

function loadConfig(cwd: string): MetisConfig {
  const path = join(cwd, 'metis.config.json');
  if (!existsSync(path)) return DEFAULT_CONFIG;
  return JSON.parse(readFileSync(path, 'utf8')) as MetisConfig;
}

function editorDir(cwd: string): string | undefined {
  const candidates = [join(cwd, 'editor'), join(cwd, 'node_modules', '@seillen', 'metis-editor', 'dist')];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function cmdUp(context: CliContext): Promise<number> {
  const config = loadConfig(context.cwd);
  const runtime = new MetisRuntime({ projectDir: context.cwd, config, log: context.stdout });
  await runtime.start();
  const seeded = await seedConnectorsIfEmpty(runtime.connectors);
  if (seeded) context.stdout(`Seeded ${seeded.seeded} connectors into the catalogue.`);
  const app = await buildControlServer({ runtime, editorDir: editorDir(context.cwd) });
  await app.listen({ port: config.ports.editor, host: '0.0.0.0' });
  context.stdout(`Editor and API on http://localhost:${config.ports.editor}`);
  context.stdout(`Temporal Web UI on http://localhost:${config.ports.temporalUi}`);
  context.stdout('Metis is up. Press Ctrl+C to stop.');
  // Block until a termination signal. bin.ts calls process.exit(code) as soon
  // as this resolves, so returning here (as the other commands do) would tear
  // down the server and worker immediately. "up" is the one long-lived command.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      app
        .close()
        .then(() => runtime.stop())
        .catch(() => undefined)
        .finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

export async function cmdConnectors(context: CliContext, sub?: string): Promise<number> {
  if (sub !== 'seed' && sub !== 'list') {
    context.stderr('usage: metis connectors <seed|list>');
    return 1;
  }
  const config = loadConfig(context.cwd);
  const runtime = new MetisRuntime({ projectDir: context.cwd, config, log: context.stdout });
  if (sub === 'seed') {
    const result = await seedConnectors(runtime.connectors);
    context.stdout(`Seeded ${result.seeded} of ${result.total} connectors into the catalogue.`);
    for (const skip of result.skipped) {
      context.stderr(`skipped ${skip.connectorId}: ${skip.problems.join('; ')}`);
    }
    return 0;
  }
  const records = await runtime.connectors.list(DEFAULT_TENANT);
  if (records.length === 0) {
    context.stdout('No connectors registered yet. Run "metis connectors seed" first.');
    return 0;
  }
  context.stdout(formatConnectorList(records));
  context.stdout('');
  context.stdout(`${records.length} connectors registered.`);
  return 0;
}

export async function cmdTriggers(context: CliContext, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub !== 'add' && sub !== 'list' && sub !== 'remove') {
    context.stderr('usage: metis triggers <add|list|remove>');
    return 1;
  }
  const config = loadConfig(context.cwd);
  const runtime = new MetisRuntime({ projectDir: context.cwd, config, log: context.stdout });

  if (sub === 'list') {
    const records = await runtime.triggers.list();
    if (records.length === 0) {
      context.stdout('No triggers yet. Add one with "metis triggers add".');
      return 0;
    }
    context.stdout(formatTriggerList(records));
    return 0;
  }

  if (sub === 'remove') {
    const triggerId = argv[1];
    if (!triggerId) {
      context.stderr('usage: metis triggers remove <triggerId>');
      return 1;
    }
    await runtime.triggers.remove(triggerId);
    context.stdout(`Removed ${triggerId}.`);
    return 0;
  }

  const { positional, flags } = parseFlags(argv.slice(1));
  try {
    const input = buildTriggerInput(positional[0], positional[1], flags);
    const created = await runtime.triggers.create(input);
    context.stdout(`Created ${created.kind} trigger ${created.triggerId} for "${created.workflowId}".`);
    if (created.kind === 'webhook') {
      context.stdout(`  POST it at /hooks/${created.triggerId}`);
    }
    if (created.kind === 'schedule') {
      context.stdout('  The schedule is provisioned in Temporal next time "metis up" runs.');
    }
    return 0;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function cmdWebhooks(context: CliContext, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub !== 'add' && sub !== 'list' && sub !== 'remove') {
    context.stderr('usage: metis webhooks <add|list|remove>');
    return 1;
  }
  const config = loadConfig(context.cwd);
  const runtime = new MetisRuntime({ projectDir: context.cwd, config, log: context.stdout });

  if (sub === 'list') {
    const records = await runtime.outbound.list();
    if (records.length === 0) {
      context.stdout('No outbound webhooks yet. Add one with "metis webhooks add".');
      return 0;
    }
    context.stdout(formatWebhookList(records));
    return 0;
  }

  if (sub === 'remove') {
    const webhookId = argv[1];
    if (!webhookId) {
      context.stderr('usage: metis webhooks remove <webhookId>');
      return 1;
    }
    await runtime.outbound.remove(webhookId);
    context.stdout(`Removed ${webhookId}.`);
    return 0;
  }

  const { positional, flags } = parseFlags(argv.slice(1));
  try {
    const input = buildWebhookInput(positional[0], flags);
    const created = await runtime.outbound.register(input);
    context.stdout(`Registered outbound webhook ${created.webhookId} -> ${created.url}`);
    context.stdout(`  events: ${created.events.join(', ')}${created.secret ? ' (signed)' : ''}`);
    return 0;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function cmdRun(context: CliContext, workflowName?: string): Promise<number> {
  if (!workflowName) {
    context.stderr('usage: metis run <workflow>');
    return 1;
  }
  const workflowFile = workflowName.endsWith('.json')
    ? join(context.cwd, workflowName)
    : join(context.cwd, 'workflows', `${workflowName}.json`);
  if (!existsSync(workflowFile)) {
    context.stderr(`workflow file not found: ${workflowFile}`);
    return 1;
  }
  const config = loadConfig(context.cwd);
  const runtime = new MetisRuntime({ projectDir: context.cwd, config, log: context.stdout });
  await runtime.start();
  try {
    const outcome = await runtime.runWorkflow(workflowFile);
    context.stdout(`status: ${outcome.status}`);
    context.stdout(JSON.stringify(outcome.result, null, 2));
    return outcome.status === 'completed' ? 0 : 1;
  } finally {
    await runtime.stop();
  }
}
