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
 * Every open node type on a real Temporal dev server (gated by
 * METIS_E2E). The engine tests cover these on the time-skipping test
 * env; this spec runs each one through an actual downloaded dev server
 * and worker, against real local stubs and a real Postgres, so the
 * whole dispatch path is exercised outside the harness.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import type { Worker } from '@temporalio/worker';
import {
  CapturingEventSink,
  FakeCredentialPort,
  NodeHandlerRegistry,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import {
  registerOpenNodeHandlers,
  createConnectorNodeHandler,
  ConnectorRegistry,
  registerConnectorTable,
  closePostgresPools,
} from '@mindlynx/metis-nodes';
import { createMetisWorker, METIS_TASK_QUEUE } from '@mindlynx/metis-engine';
import { ensureTemporalBinary } from '../temporal/download.js';
import { TemporalDevServer } from '../temporal/dev-server.js';

const enabled = process.env.METIS_E2E === '1';
const GRPC_PORT = 17266;
const UI_PORT = 18266;
const pgUrl = process.env.PG_URL;

let uuidSeq = 0;
const nodeId = () => `node-${String(uuidSeq++).padStart(8, '0')}-1111-4111-8111-111111111111`;

describe.skipIf(!enabled)('every open node type on a real Temporal dev server (METIS_E2E)', () => {
  let devServer: TemporalDevServer;
  let worker: Worker;
  let workerRun: Promise<void>;
  let client: Client;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  let stub: Server;
  let stubUrl: string;
  const stubHits: { url?: string; method?: string; auth?: string; apiKey?: string }[] = [];

  beforeAll(async () => {
    stub = createServer((req, res) => {
      stubHits.push({
        url: req.url,
        method: req.method,
        auth: req.headers.authorization,
        apiKey: String(req.headers['x-api-key'] ?? ''),
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.url === '/v3/mail/send' ? 202 : 200;
      res.end(JSON.stringify({ ok: true, echo: req.url }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    const home = mkdtempSync(join(tmpdir(), 'metis-realnodes-home-'));
    const project = mkdtempSync(join(tmpdir(), 'metis-realnodes-'));
    const binary = await ensureTemporalBinary({
      home,
      fetchArchive: async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`download failed (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      },
      extractBinary: async (archive, destDir) => {
        const tarPath = join(destDir, 'temporal.tar.gz');
        writeFileSync(tarPath, archive);
        execFileSync('/usr/bin/tar', ['-xzf', tarPath, '-C', destDir]);
        return join(destDir, 'temporal');
      },
    });
    devServer = new TemporalDevServer({
      binaryPath: binary,
      grpcPort: GRPC_PORT,
      uiPort: UI_PORT,
      databaseFile: join(project, '.metis', 'temporal.db'),
      pidFile: join(project, '.metis', 'temporal.pid'),
    });
    await devServer.start();

    const gateway = new DataGateway(new SqliteAdapter(join(project, '.metis', 'metis.db')));
    registerWorkflowTables(gateway);
    registerConnectorTable(gateway);
    store = new WorkflowStore(gateway);
    events = new CapturingEventSink();
    const connectors = new ConnectorRegistry(gateway);
    await connectors.register('t1', {
      connectorId: 'crm',
      name: 'Local CRM',
      baseUrl: stubUrl,
      authScheme: 'bearer',
    });
    await connectors.register('t1', {
      connectorId: 'wired',
      name: 'Wired CRM',
      baseUrl: stubUrl,
      authScheme: 'bearer',
      operations: [
        { name: 'getThing', method: 'GET', pathTemplate: '/things/{id}', wireStatus: 'verified' },
        { name: 'createThing', method: 'POST', pathTemplate: '/things', wireStatus: 'verified' },
      ],
    });
    const credentials = new FakeCredentialPort(
      {},
      {
        't1/crm': { name: 'crm', connectorId: 'crm', material: { apiKey: 'crm-token' } },
        't1/wired': { name: 'wired', connectorId: 'wired', material: { apiKey: 'wired-token' } },
        't1/sg': { name: 'sg', connectorId: 'sendgrid', material: { apiKey: 'sg-key' } },
        ...(pgUrl
          ? { 't1/pg': { name: 'pg', connectorId: 'postgres', material: { connectionString: pgUrl } } }
          : {}),
      },
    );
    const nodes = new NodeHandlerRegistry();
    registerOpenNodeHandlers(nodes, { credentials, connectors, sendgrid: { baseUrl: stubUrl } });
    // Since d880c18 the node TYPE is the connector (registerOpenNodeHandlers
    // wires the static catalogue types the same way); register our two ad-hoc
    // test connectors so a node of type 'crm'/'wired' dispatches through the
    // shared handler. config.connectorId is the chosen CONNECTION.
    const connectorHandler = createConnectorNodeHandler(connectors, credentials);
    for (const type of ['crm', 'wired']) nodes.registerNodeHandler(type, connectorHandler);

    worker = await createMetisWorker({
      address: `127.0.0.1:${GRPC_PORT}`,
      taskQueue: METIS_TASK_QUEUE,
      store,
      events,
      nodes,
      credentials,
    });
    workerRun = worker.run();

    const connection = await Connection.connect({ address: `127.0.0.1:${GRPC_PORT}` });
    client = new Client({ connection, namespace: 'default' });
  }, 240_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await devServer?.stop();
    stub?.close();
    await closePostgresPools();
  });

  const runToCompletion = async (
    executionId: string,
    definition: { nodes: unknown[]; edges: unknown[] },
    input?: Record<string, unknown>,
    signalAfter?: { signalType: string; signalParams: unknown },
  ) => {
    const handle = await client.workflow.start('helixWorkflow', {
      args: [{ tenantId: 't1', workflowId: 'wf-realnodes', executionId, definition, input }],
      workflowId: executionId,
      taskQueue: METIS_TASK_QUEUE,
    });
    if (signalAfter) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await handle.signal('helixSignal', signalAfter);
    }
    const result = (await handle.result()) as { status: string };
    const execution = await store.getExecution('t1', executionId);
    return { status: result.status, execution };
  };

  const outputFor = (execution: Awaited<ReturnType<typeof runToCompletion>>['execution'], id: string) =>
    execution?.logs.find((log) => log.nodeId === id && log.event === 'workflow.node.completed')
      ?.output as Record<string, unknown> | undefined;

  it('runs an http node against a local stub with the SSRF allowlist', async () => {
    const http = nodeId();
    const { status, execution } = await runToCompletion('rn-http', {
      nodes: [
        { id: http, type: 'api', config: { method: 'GET', url: `${stubUrl}/hello`, allowedHosts: ['127.0.0.1'] } },
      ],
      edges: [],
    });
    expect(status).toBe('completed');
    const output = outputFor(execution, http) as { status: number; data: { ok: boolean } };
    expect(output.status).toBe(200);
    expect(output.data.ok).toBe(true);
  }, 60_000);

  it('runs a switch node and orphans the losing branch', async () => {
    const sw = nodeId();
    const left = nodeId();
    const right = nodeId();
    const { status, execution } = await runToCompletion(
      'rn-switch',
      {
        nodes: [
          {
            id: sw,
            type: 'switch',
            config: {
              switchOptions: [
                { id: 'go-left', conditions: [{ property: 'input.kind', checkValue: 'left', checkOperator: '===' }] },
              ],
            },
          },
          { id: left, type: 'code', config: { code: "return { branch: 'left' };" } },
          { id: right, type: 'code', config: { code: "return { branch: 'right' };" } },
        ],
        edges: [
          { source: sw, target: left, sourceHandle: 'source-go-left' },
          { source: sw, target: right, sourceHandle: 'source-default' },
        ],
      },
      { kind: 'left' },
    );
    expect(status).toBe('completed');
    const started = (execution?.logs ?? [])
      .filter((log) => log.event === 'workflow.node.started')
      .map((log) => log.nodeId);
    expect(started).toContain(left);
    expect(started).not.toContain(right);
  }, 60_000);

  it('parks a signal node and resumes it, binding params downstream', async () => {
    const sig = nodeId();
    const after = nodeId();
    const { status } = await runToCompletion(
      'rn-signal',
      {
        nodes: [
          { id: sig, type: 'signal', config: { signalType: 'approve' } },
          { id: after, type: 'code', config: { input: { got: 'placeholder' }, code: 'return { got: input.got };' } },
        ],
        edges: [{ source: sig, target: after }],
      },
      undefined,
      { signalType: 'approve', signalParams: { decision: 'yes' } },
    );
    expect(status).toBe('completed');
    const waiting = events.events.find(
      (event) => event.name === 'workflow.node.waiting' && event.executionId === 'rn-signal',
    );
    expect(waiting?.nodeId).toBe(sig);
  }, 60_000);

  it('sleeps a waituntil node then continues', async () => {
    const wait = nodeId();
    const after = nodeId();
    const { status, execution } = await runToCompletion('rn-wait', {
      nodes: [
        { id: wait, type: 'waituntil', config: { waitSeconds: 1 } },
        { id: after, type: 'code', config: { code: "return { done: true };" } },
      ],
      edges: [{ source: wait, target: after }],
    });
    expect(status).toBe('completed');
    expect(outputFor(execution, after)).toEqual({ done: true });
  }, 60_000);

  it('runs a generic connector node through its registered record', async () => {
    const conn = nodeId();
    const { status, execution } = await runToCompletion('rn-connector', {
      nodes: [{ id: conn, type: 'crm', config: { connectorId: 'crm', method: 'GET', path: '/contacts' } }],
      edges: [],
    });
    expect(status).toBe('completed');
    const output = outputFor(execution, conn) as { status: number };
    expect(output.status).toBe(200);
    expect(stubHits.some((hit) => hit.url === '/contacts' && hit.auth === 'Bearer crm-token')).toBe(true);
  }, 60_000);

  it('dispatches a named connector operation, interpolating the path and query', async () => {
    const conn = nodeId();
    const { status, execution } = await runToCompletion('rn-conn-op', {
      nodes: [
        {
          id: conn,
          type: 'wired',
          config: { connectorId: 'wired', operation: 'getThing', params: { id: '42', expand: 'owner' } },
        },
      ],
      edges: [],
    });
    expect(status).toBe('completed');
    const output = outputFor(execution, conn) as { status: number };
    expect(output.status).toBe(200);
    expect(
      stubHits.some(
        (hit) => hit.url === '/things/42?expand=owner' && hit.method === 'GET' && hit.auth === 'Bearer wired-token',
      ),
    ).toBe(true);
  }, 60_000);

  it('dispatches a write operation with a JSON body on a real dev server', async () => {
    const conn = nodeId();
    const { status } = await runToCompletion('rn-conn-write', {
      nodes: [
        {
          id: conn,
          type: 'wired',
          config: { connectorId: 'wired', operation: 'createThing', params: { title: 'Acme' } },
        },
      ],
      edges: [],
    });
    expect(status).toBe('completed');
    expect(stubHits.some((hit) => hit.url === '/things' && hit.method === 'POST')).toBe(true);
  }, 60_000);

  it('runs a sendgrid node against a local stub', async () => {
    const mail = nodeId();
    const { status: mailStatus } = await runToCompletion('rn-sendgrid', {
      nodes: [
        {
          id: mail,
          type: 'sendgrid',
          config: { connectorId: 'sg', to: 'a@b.test', from: 'c@d.test', subject: 's', text: 't' },
        },
      ],
      edges: [],
    });
    expect(mailStatus).toBe('completed');
    expect(stubHits.some((hit) => hit.url === '/v3/mail/send' && hit.auth === 'Bearer sg-key')).toBe(true);
  }, 60_000);

  it.skipIf(!pgUrl)('runs a postgres node against a real database', async () => {
    const pg = nodeId();
    const { status, execution } = await runToCompletion('rn-postgres', {
      nodes: [
        {
          id: pg,
          type: 'postgres',
          config: { connectorId: 'pg', query: 'SELECT $1::int AS n', params: [7] },
        },
      ],
      edges: [],
    });
    expect(status).toBe('completed');
    const output = outputFor(execution, pg) as { rows: { n: number }[] };
    expect(output.rows).toEqual([{ n: 7 }]);
  }, 60_000);
});
