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
 * The collapsed single-process runtime. On a laptop the
 * Temporal dev server, the worker, the control plane and the editor
 * all run in one supervised tree. This module owns their lifecycle so
 * `metis up` and `metis run` share exactly one wiring.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  CapabilityGatewayClient,
  CapabilityResolver,
  CloudEntitlementsClient,
  CompositeEventSink,
  LocalEventBus,
  LocalFileCredentialStore,
  NodeHandlerRegistry,
  SingleTenantIdentity,
  StdoutEventSink,
  helixAccountBearer,
  isCompleted,
  nodeOutput,
  type ConnectorCredentialStore,
  type NodeExecPort,
} from '@mindlynx/metis-ports';
import { getCatalogue, getEntry } from '@mindlynx/metis-catalogue';
import {
  DataGateway,
  createDataStoreFromEnv,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import {
  registerOpenNodeHandlers,
  ConnectorRegistry,
  registerConnectorTable,
  createConnectorNodeHandler,
} from '@mindlynx/metis-nodes';
import {
  createMetisWorker,
  METIS_TASK_QUEUE,
  validateDefinition,
  type WorkflowDefinition,
} from '@mindlynx/metis-engine';
import {
  TemporalExecutionAdapter,
  TriggerService,
  registerTriggerTable,
  ScheduleService,
  StatusReconciler,
  ConnectorPoller,
  OutboundWebhookService,
  registerOutboundWebhookTable,
  type FetchItems,
  type TriggerRecord,
} from '@mindlynx/metis-orchestrator';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ensureTemporalBinary,
  type EnsureDeps,
} from './temporal/download.js';
import { TemporalDevServer, defaultDevServerPaths } from './temporal/dev-server.js';
import { seedUsers } from './seed-users.js';
import type { MetisConfig } from './scaffold.js';

export interface RuntimeOptions {
  projectDir: string;
  config: MetisConfig;
  log: (line: string) => void;
  /**
   * When set, connect to this already-running Temporal (the compose
   * service) instead of downloading and booting a dev server.
   */
  externalTemporalAddress?: string;
}

function loadCredentialKey(projectDir: string): Buffer {
  const metisDir = join(projectDir, '.metis');
  mkdirSync(metisDir, { recursive: true });
  const keyPath = join(metisDir, 'credential.key');
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, 'utf8'), 'hex');
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}

export const TENANT = 't1';

/**
 * The worker's NodeExecPort. METIS_HELIX_GATEWAY_URL set = wrap the registry
 * with the capability resolver (cloud binds only with entitlement + consent +
 * an explicit choice). Absent = the kill switch: an air-gapped install never
 * makes a cloud call, and the palette shows a static paid-capabilities view.
 */
function buildExecPort(
  registry: NodeHandlerRegistry,
  credentials: ConnectorCredentialStore,
): { port: NodeExecPort; gateway?: CapabilityGatewayClient } {
  const gatewayUrl = process.env.METIS_HELIX_GATEWAY_URL;
  if (!gatewayUrl) return { port: registry };
  // Rotation-safe bearer: the token endpoint is resolved lazily from the
  // identity provider's discovery document (never an assumed path).
  const identityUrl = process.env.METIS_HELIX_IDENTITY_URL ?? gatewayUrl;
  const clientId = process.env.METIS_HELIX_CLIENT_ID ?? 'metis-editor';
  const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl, clientId });
  const entitlements = new CloudEntitlementsClient({ baseUrl: gatewayUrl, getBearer });
  const gateway = new CapabilityGatewayClient({ baseUrl: gatewayUrl, getBearer });
  return {
    // 'park' mode: the worker parks accepted cloud jobs on the durable
    // wait instead of polling inside the 2-minute activity budget.
    port: new CapabilityResolver({
      local: registry,
      entryFor: (type) => getEntry(getCatalogue(), type),
      entitlements: () => entitlements.capabilities(),
      gateway,
      mode: 'park',
    }),
    gateway,
  };
}
const POLL_INTERVAL_MS = Number(process.env.METIS_POLL_INTERVAL_MS ?? 30_000);
const ITEM_ARRAY_KEYS = ['results', 'data', 'items', 'records', 'value'];

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** Pull the item array out of a poll response, honouring an explicit path. */
function extractItems(data: unknown, itemsPath?: string): unknown[] {
  const base = itemsPath ? readPath(data, itemsPath) : data;
  if (Array.isArray(base)) return base;
  if (data && typeof data === 'object') {
    for (const key of ITEM_ARRAY_KEYS) {
      const candidate = (data as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

const OUTBOUND_TIMEOUT_MS = 10_000;

/** POST an outbound webhook to an operator-registered URL, with a timeout. */
async function httpDeliver(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported webhook scheme "${parsed.protocol}"`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    return { status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export class MetisRuntime {
  private devServer: TemporalDevServer | undefined;
  private worker: Worker | undefined;
  private workerRun: Promise<void> | undefined;

  readonly bus = new LocalEventBus();
  readonly store: WorkflowStore;
  readonly gateway: DataGateway;
  readonly connectors: ConnectorRegistry;
  readonly triggers: TriggerService;
  readonly outbound: OutboundWebhookService;
  readonly identity: Promise<SingleTenantIdentity>;
  readonly nodes = new NodeHandlerRegistry();
  readonly address: string;
  private schedules: ScheduleService | undefined;
  private reconciler: StatusReconciler | undefined;
  private poller: ConnectorPoller | undefined;

  constructor(private readonly options: RuntimeOptions) {
    this.address =
      options.externalTemporalAddress ?? `127.0.0.1:${options.config.ports.temporalGrpc}`;
    const dbFile = join(options.projectDir, options.config.paths.database);
    this.gateway = new DataGateway(createDataStoreFromEnv(process.env, dbFile));
    registerWorkflowTables(this.gateway);
    registerConnectorTable(this.gateway);
    registerTriggerTable(this.gateway);
    registerOutboundWebhookTable(this.gateway);
    this.store = new WorkflowStore(this.gateway, { executionTtlDays: this.options.config.retentionDays });
    this.connectors = new ConnectorRegistry(this.gateway);
    this.triggers = new TriggerService(this.gateway, TENANT);
    this.outbound = new OutboundWebhookService(this.gateway, TENANT, {
      deliver: httpDeliver,
      log: options.log,
    });
    const credentials = new LocalFileCredentialStore(
      join(options.projectDir, '.metis', 'credentials.enc'),
      loadCredentialKey(options.projectDir),
    );
    registerOpenNodeHandlers(this.nodes, { credentials, connectors: this.connectors });
    this.identity = SingleTenantIdentity.create(TENANT, seedUsers(process.env));
    this.credentials = credentials;
    const exec = buildExecPort(this.nodes, credentials);
    this.execPort = exec.port;
    this.cloudGateway = exec.gateway;
  }

  readonly credentials: LocalFileCredentialStore;

  /** What the worker dispatches through: the registry, wrapped by the
   *  capability resolver when a Helix gateway is configured. */
  readonly execPort: NodeExecPort;

  /** The shared gateway client (parked-job polling); undefined = kill switch. */
  readonly cloudGateway?: CapabilityGatewayClient;

  /** Start the dev server (downloading it if needed) and the worker. */
  async start(downloadDeps?: Partial<EnsureDeps>): Promise<void> {
    if (this.options.externalTemporalAddress) {
      await this.startWorker(`Worker running against Temporal at ${this.address}.`);
      return;
    }
    const binary = await ensureTemporalBinary({
      fetchArchive:
        downloadDeps?.fetchArchive ??
        (async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`download failed (${response.status})`);
          return new Uint8Array(await response.arrayBuffer());
        }),
      extractBinary:
        downloadDeps?.extractBinary ??
        (async (archive, destDir) => {
          const tarPath = join(destDir, 'temporal.tar.gz');
          writeFileSync(tarPath, archive);
          // tar's location varies by distro (/usr/bin, /bin), so PATH
          // resolution is required for portability.
          // eslint-disable-next-line sonarjs/no-os-command-from-path
          execFileSync('tar', ['-xzf', tarPath, '-C', destDir]);
          return join(destDir, 'temporal');
        }),
      ...downloadDeps,
    });
    this.options.log('Temporal dev server ready.');

    const paths = defaultDevServerPaths(this.options.projectDir);
    this.devServer = new TemporalDevServer({
      binaryPath: binary,
      grpcPort: this.options.config.ports.temporalGrpc,
      uiPort: this.options.config.ports.temporalUi,
      databaseFile: paths.databaseFile,
      pidFile: paths.pidFile,
    });
    await this.devServer.start();
    await this.startWorker('Worker running.');
  }

  /** Start the worker (against the dev server or an external Temporal). */
  private async startWorker(readyLine: string): Promise<void> {
    const events = new CompositeEventSink(new StdoutEventSink(this.options.log), this.bus);
    this.worker = await createMetisWorker({
      address: this.address,
      taskQueue: METIS_TASK_QUEUE,
      store: this.store,
      events,
      nodes: this.execPort,
      credentials: this.credentials,
      gateway: this.cloudGateway,
    });
    this.workerRun = this.worker.run();
    this.options.log(readyLine);
    await this.startTriggers();
  }

  /**
   * Bring up the trigger substrate once the worker is live: reconcile
   * schedule triggers into native Temporal Schedules, then start the
   * connector poll bridge. Webhook triggers need nothing here; they fire
   * through the control-server's /hooks route.
   */
  private async startTriggers(): Promise<void> {
    const executions = new TemporalExecutionAdapter({
      address: this.address,
      taskQueue: METIS_TASK_QUEUE,
    });
    this.schedules = new ScheduleService(this.store, {
      address: this.address,
      taskQueue: METIS_TASK_QUEUE,
    });
    this.poller = new ConnectorPoller({
      triggers: this.triggers,
      store: this.store,
      executions,
      tenantId: TENANT,
      fetchItems: this.buildFetchItems(),
      newExecutionId: () => `exec_${randomUUID()}`,
      log: this.options.log,
    });
    await this.reconcileSchedules();
    this.poller.start(POLL_INTERVAL_MS);
    this.outbound.init(this.bus);
    // Sync store rows Temporal says are finished (a hard terminate skips the
    // engine's own lifecycle activities and would leave "running" forever).
    this.reconciler = new StatusReconciler({
      store: this.store,
      executions,
      events: this.bus,
      tenantId: TENANT,
      log: this.options.log,
    });
    this.reconciler.start(60_000);
  }

  /** Ensure every enabled schedule trigger has a live Temporal Schedule. */
  private async reconcileSchedules(): Promise<void> {
    if (!this.schedules) return;
    for (const trigger of await this.triggers.listByKind('schedule')) {
      if (!trigger.enabled || !trigger.cron) continue;
      try {
        await this.schedules.create(TENANT, trigger.workflowId, trigger.cron);
        this.options.log(`Scheduled ${trigger.workflowId} (${trigger.cron}).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already/i.test(message)) {
          this.options.log(`Schedule for ${trigger.workflowId} skipped: ${message}`);
        }
      }
    }
  }

  /** The poll fetcher: run a connector's poll operation and lift its items. */
  private buildFetchItems(): FetchItems {
    const handler = createConnectorNodeHandler(this.connectors, this.credentials);
    return async (trigger: TriggerRecord) => {
      if (!trigger.connectorId || !trigger.operation) return [];
      const result = await handler({
        nodeRef: {
          id: 'poll',
          type: 'connector',
          config: {
            connectorId: trigger.connectorId,
            operation: trigger.operation,
            params: trigger.pollParams ?? {},
          },
        },
        tenantId: TENANT,
        executionId: `poll_${trigger.triggerId}`,
        workflowId: trigger.workflowId,
        workflowState: { states: [] },
      });
      if (!isCompleted(result.status)) return [];
      const data = (nodeOutput(result) as { data?: unknown } | undefined)?.data;
      return extractItems(data, trigger.itemsPath);
    };
  }

  /**
   * Publish a workflow file and run it to completion, returning the
   * terminal execution record. Used by `metis run`.
   */
  async runWorkflow(
    workflowFile: string,
  ): Promise<{ status: string; result: { meta: Record<string, unknown>; logs: unknown[] } }> {
    const parsed = JSON.parse(readFileSync(workflowFile, 'utf8')) as {
      workflowId: string;
      name?: string;
      type?: string;
      definition: WorkflowDefinition;
    };
    const kind = parsed.type === 'api' ? 'api' : 'workflow';
    const validation = validateDefinition(parsed.definition, { kind, level: 'start' });
    if (!validation.valid) {
      throw new Error(`invalid definition: ${validation.errors.join('; ')}`);
    }

    const executions = new TemporalExecutionAdapter({
      address: this.address,
      taskQueue: METIS_TASK_QUEUE,
    });
    const executionId = `exec_${randomUUID()}`;
    await executions.start({
      tenantId: TENANT,
      workflowId: parsed.workflowId,
      executionId,
      workflowType: kind === 'api' ? 'helixApiWorkflow' : 'helixWorkflow',
      definition: parsed.definition,
      input: { startedAt: new Date().toISOString() },
    } as never);

    const deadline = Date.now() + 60_000;
    let meta: { status: string } | undefined;
    while (Date.now() < deadline) {
      const execution = await this.store.getExecution(TENANT, executionId);
      if (execution && execution.meta.status !== 'running') {
        return {
          status: String(execution.meta.status),
          result: { meta: execution.meta, logs: execution.logs },
        };
      }
      meta = execution?.meta;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`workflow did not finish within 60s (last status: ${meta?.status ?? 'unknown'})`);
  }

  async stop(): Promise<void> {
    this.reconciler?.stop();
    this.poller?.stop();
    this.outbound.stop();
    this.worker?.shutdown();
    await this.workerRun?.catch(() => undefined);
    await this.devServer?.stop();
  }
}
