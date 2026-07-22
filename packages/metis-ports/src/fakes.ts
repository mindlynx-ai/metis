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
import {
  ConditionFailedError,
  type DataStore,
  type ItemKey,
  type ItemRecord,
  type PutOptions,
  type QueryPage,
  type QueryRequest,
  type TableDefinition,
} from './data-store.js';
import type {
  NodeExecPort,
  NodeHandler,
  NodeHandlerContext,
  NodeExecutionResult,
} from './node-exec-port.js';
import type {
  ConnectionRecord,
  ConnectorCredentialStore,
  CreateConnectionInput,
  SecretRequest,
} from './credential-port.js';
import type { EventSink, WorkflowEvent } from './event-sink.js';
import type {
  ApiRunResult,
  ExecutionPort,
  ExecutionStatusValue,
  StartExecutionRequest,
} from './execution-port.js';
import type { Action, IdentityPort, Role, Session } from './identity-port.js';

/**
 * Typed in-memory fakes proving each port contract. They are
 * exported for reuse by downstream test suites; the in-memory DataStore
 * fake is also the seed of the conformance reference adapter.
 */

function compositeKey(key: ItemKey): string {
  return `${key.partitionKey}\u0000${key.sortKey ?? ''}`;
}

export class FakeDataStore implements DataStore {
  private readonly tables = new Map<string, TableDefinition>();
  private readonly rows = new Map<string, Map<string, ItemRecord>>();

  registerTable(definition: TableDefinition): void {
    this.tables.set(definition.name, definition);
    if (!this.rows.has(definition.name)) this.rows.set(definition.name, new Map());
  }

  private definitionOf(table: string): TableDefinition {
    const definition = this.tables.get(table);
    if (!definition) throw new Error(`table "${table}" is not registered`);
    return definition;
  }

  private keyOf(table: string, item: ItemRecord): ItemKey {
    const definition = this.definitionOf(table);
    return {
      partitionKey: String(item[definition.partitionAttribute]),
      sortKey: definition.sortAttribute ? String(item[definition.sortAttribute] ?? '') : undefined,
    };
  }

  get(table: string, key: ItemKey): Promise<ItemRecord | undefined> {
    this.definitionOf(table);
    const item = this.rows.get(table)?.get(compositeKey(key));
    return Promise.resolve(item ? { ...item } : undefined);
  }

  put(table: string, item: ItemRecord, options?: PutOptions): Promise<void> {
    const key = compositeKey(this.keyOf(table, item));
    const bucket = this.rows.get(table);
    if (!bucket) throw new Error(`table "${table}" is not registered`);
    const exists = bucket.has(key);
    if (options?.condition === 'must-not-exist' && exists) {
      return Promise.reject(new ConditionFailedError('item already exists'));
    }
    if (options?.condition === 'must-exist' && !exists) {
      return Promise.reject(new ConditionFailedError('item does not exist'));
    }
    bucket.set(key, { ...item });
    return Promise.resolve();
  }

  async patch(table: string, key: ItemKey, changes: ItemRecord): Promise<void> {
    const existing = await this.get(table, key);
    if (!existing) throw new ConditionFailedError('item does not exist');
    this.rows.get(table)?.set(compositeKey(key), { ...existing, ...changes });
  }

  deleteItem(table: string, key: ItemKey): Promise<void> {
    this.definitionOf(table);
    this.rows.get(table)?.delete(compositeKey(key));
    return Promise.resolve();
  }

  query(request: QueryRequest): Promise<QueryPage> {
    const definition = this.definitionOf(request.table);
    const index = request.index
      ? definition.indexes?.find((candidate) => candidate.name === request.index)
      : undefined;
    if (request.index && !index) {
      throw new Error(`index "${request.index}" is not defined on table "${request.table}"`);
    }
    const partitionAttribute = index?.partitionAttribute ?? definition.partitionAttribute;
    const sortAttribute = index?.sortAttribute ?? definition.sortAttribute;

    let matches = [...(this.rows.get(request.table)?.values() ?? [])].filter(
      (item) => String(item[partitionAttribute]) === request.partitionValue,
    );
    if (sortAttribute && request.sortPrefix !== undefined) {
      matches = matches.filter((item) =>
        String(item[sortAttribute] ?? '').startsWith(request.sortPrefix ?? ''),
      );
    }
    if (sortAttribute && request.sortRange) {
      const { from, to } = request.sortRange;
      matches = matches.filter((item) => {
        const value = String(item[sortAttribute] ?? '');
        if (from !== undefined && value < from) return false;
        if (to !== undefined && value > to) return false;
        return true;
      });
    }
    if (sortAttribute) {
      matches.sort((a, b) =>
        String(a[sortAttribute] ?? '').localeCompare(String(b[sortAttribute] ?? '')),
      );
      if (request.ascending === false) matches.reverse();
    }
    const offset = request.cursor ? Number.parseInt(request.cursor, 10) : 0;
    const limit = request.limit ?? matches.length;
    const items = matches.slice(offset, offset + limit).map((item) => ({ ...item }));
    const nextOffset = offset + items.length;
    return Promise.resolve({
      items,
      cursor: nextOffset < matches.length ? String(nextOffset) : undefined,
    });
  }
}

/** Build a NodeHandlerContext for a handler under test (the new contract). */
export function nodeCtx(
  type: string,
  config: Record<string, unknown>,
  opts: { id?: string; tenantId?: string; inputData?: Record<string, unknown> } = {},
): NodeHandlerContext {
  return {
    nodeRef: { id: opts.id ?? 'n1', type, config },
    tenantId: opts.tenantId ?? 't1',
    executionId: 'e1',
    workflowId: 'w1',
    workflowState: { states: [] },
    inputData: opts.inputData,
  };
}

export class FakeNodeExecPort implements NodeExecPort {
  constructor(private readonly handlers: Record<string, NodeHandler> = {}) {}

  canExecute(type: string): boolean {
    return type in this.handlers;
  }

  execute(ctx: NodeHandlerContext): Promise<NodeExecutionResult> {
    const handler = this.handlers[ctx.nodeRef.type];
    if (!handler) {
      return Promise.resolve({
        status: 501,
        message: `node type "${ctx.nodeRef.type}" is not available in this edition`,
      });
    }
    return handler(ctx);
  }
}

interface FakeConnection {
  name: string;
  connectorId: string;
  connectionType?: string;
  baseUrl?: string;
  authScheme?: string;
  material: Record<string, string>;
}

export class FakeCredentialPort implements ConnectorCredentialStore {
  private seq = 0;

  constructor(
    private readonly secrets: Record<string, string> = {},
    private readonly connections: Record<string, FakeConnection> = {},
  ) {}

  resolveSecret(request: SecretRequest): Promise<string> {
    const value = this.secrets[`${request.tenantId}/${request.secretId}`];
    if (value === undefined) {
      return Promise.reject(new Error(`secret ${request.secretId} is not defined`));
    }
    return Promise.resolve(value);
  }

  resolveConnectorCredentials(
    tenantId: string,
    connectionId: string,
  ): Promise<Record<string, string>> {
    const connection = this.connections[`${tenantId}/${connectionId}`];
    if (!connection) {
      return Promise.reject(new Error(`connection ${connectionId} has no credentials`));
    }
    return Promise.resolve({ ...connection.material });
  }

  createConnection(tenantId: string, input: CreateConnectionInput): Promise<ConnectionRecord> {
    this.seq += 1;
    const connectionId = `conn_fake_${this.seq}`;
    this.connections[`${tenantId}/${connectionId}`] = {
      name: input.name,
      connectorId: input.connectorId,
      connectionType: input.connectionType,
      baseUrl: input.baseUrl,
      authScheme: input.authScheme,
      material: input.material,
    };
    return Promise.resolve({
      connectionId,
      name: input.name,
      connectorId: input.connectorId,
      connectionType: input.connectionType,
      baseUrl: input.baseUrl,
      authScheme: input.authScheme,
    });
  }

  updateConnection(
    tenantId: string,
    connectionId: string,
    changes: { name?: string; material?: Record<string, string> },
  ): Promise<void> {
    const existing = this.connections[`${tenantId}/${connectionId}`];
    if (!existing) return Promise.reject(new Error(`connection ${connectionId} not found`));
    if (changes.name !== undefined) existing.name = changes.name;
    // Merge, never replace (see LocalFileCredentialStore.updateConnection).
    if (changes.material !== undefined) {
      existing.material = { ...existing.material, ...changes.material };
    }
    return Promise.resolve();
  }

  deleteConnection(tenantId: string, connectionId: string): Promise<void> {
    delete this.connections[`${tenantId}/${connectionId}`];
    return Promise.resolve();
  }

  listConnections(tenantId: string): Promise<ConnectionRecord[]> {
    const prefix = `${tenantId}/`;
    return Promise.resolve(
      Object.entries(this.connections)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          connectionId: key.slice(prefix.length),
          name: value.name,
          connectorId: value.connectorId,
          connectionType: value.connectionType,
          baseUrl: value.baseUrl,
          authScheme: value.authScheme,
        })),
    );
  }
}

export class CapturingEventSink implements EventSink {
  readonly events: WorkflowEvent[] = [];

  emit(event: WorkflowEvent): void {
    this.events.push(event);
  }
}

interface FakeExecution {
  request: StartExecutionRequest;
  status: ExecutionStatusValue;
  signals: { name: string; payload?: Record<string, unknown> }[];
}

export class FakeExecutionPort implements ExecutionPort {
  private readonly executions = new Map<string, FakeExecution>();

  /** Override to control synchronous api-run behaviour in tests; defaults to
   * a completed run echoing the request input as the body. */
  apiRunner: (request: StartExecutionRequest) => Promise<ApiRunResult> = (request) =>
    Promise.resolve({
      executionId: request.executionId,
      status: 'completed',
      response: request.input ?? {},
      statusCode: 200,
    });

  start(request: StartExecutionRequest): Promise<{ executionId: string }> {
    this.executions.set(request.executionId, { request, status: 'running', signals: [] });
    return Promise.resolve({ executionId: request.executionId });
  }

  startApiAndWait(request: StartExecutionRequest): Promise<ApiRunResult> {
    return this.apiRunner(request);
  }

  private executionOf(executionId: string): FakeExecution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`execution ${executionId} not found`);
    return execution;
  }

  signal(
    executionId: string,
    signalName: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    this.executionOf(executionId).signals.push({ name: signalName, payload });
    return Promise.resolve();
  }

  cancel(executionId: string): Promise<void> {
    this.executionOf(executionId).status = 'cancelled';
    return Promise.resolve();
  }

  queryStatus(executionId: string): Promise<ExecutionStatusValue> {
    return Promise.resolve(this.executionOf(executionId).status);
  }

  describe(executionId: string): Promise<Record<string, unknown>> {
    const execution = this.executionOf(executionId);
    return Promise.resolve({
      executionId,
      workflowType: execution.request.workflowType,
      status: execution.status,
      signalCount: execution.signals.length,
    });
  }
}

export interface FakeUser {
  userId: string;
  secret: string;
  role: Role;
}

export class FakeIdentityPort implements IdentityPort {
  constructor(
    private readonly tenantId: string,
    private readonly users: FakeUser[],
  ) {}

  authenticate(userId: string, secret: string): Promise<Session | undefined> {
    const user = this.users.find(
      (candidate) => candidate.userId === userId && candidate.secret === secret,
    );
    if (!user) return Promise.resolve(undefined);
    return Promise.resolve({ userId: user.userId, tenantId: this.tenantId, role: user.role });
  }

  verify(token: string): Promise<Session | undefined> {
    const user = this.users.find((candidate) => candidate.userId === token);
    if (!user) return Promise.resolve(undefined);
    return Promise.resolve({ userId: user.userId, tenantId: this.tenantId, role: user.role });
  }

  can(session: Session, action: Action): boolean {
    if (action === 'view') return true;
    if (action === 'edit') return session.role === 'admin' || session.role === 'editor';
    return session.role === 'admin';
  }
}
