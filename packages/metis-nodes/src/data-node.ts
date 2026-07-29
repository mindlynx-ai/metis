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
 * The generic "Data" node: engine-agnostic read/write over any data source. It
 * resolves the connection's engine to a DataSource adapter (postgres in the open
 * edition; athena/snowflake are adapters in the Helix build) and runs either a
 * raw query (`config.query`) or the visual table builder (`config.operation` +
 * tables/where/...). It never names Postgres - the adapter does. Result rows are
 * capped by the adapter so a big result can't overflow the workflow payload.
 */
import {
  stateEnvelope,
  type CredentialPort,
  type DatasetRef,
  type DataSourceRegistry,
  type NodeHandler,
  type QueryResult,
} from '@mindlynx/metis-ports';
import { buildQuery, dialectFor, type PgBuilderConfig } from './postgres-query.js';

interface DataNodeConfig extends PgBuilderConfig {
  /** The chosen connection instance id (material is resolved from this). */
  connectorId?: string;
  connectionId?: string;
  /** The connection's engine; the inspector sets it, defaulting to postgres. */
  engine?: string;
  /** Raw-query mode: a SQL string (+ optional $1/$2 params). */
  query?: string;
  params?: unknown[];
  /** 'rows' (default) inlines the capped rows; 'reference' hands on a small
   *  dataset handle a later step materialises on demand. */
  output?: 'rows' | 'reference';
  /** A dataset handle from an earlier step to materialise. It arrives as an
   *  object, or - when templated into a text field - as that object's JSON
   *  string. When set it supplies the connection + query. */
  sourceRef?: unknown;
}

const WRITE_OPS = new Set(['insert', 'update', 'delete', 'upsert']);

/** Node types that name their engine. `data` is the generic one and does not. */
const NAMED_ENGINE_NODES = new Set(['postgres', 'mysql', 'snowflake', 'sqlserver']);

/** The step output: the rows, plus `row` = the first record so a downstream
 *  step can reference a single result's field cleanly ({{step.data.row.email}}). */
function withFirstRow(result: QueryResult): QueryResult & { row?: Record<string, unknown> } {
  return result.rows.length > 0 ? { ...result, row: result.rows[0] } : result;
}

/** Coerce a config value into a DatasetRef, whether it came through as an object
 *  or, because it was templated into a text field, as that object's JSON string. */
function asDatasetRef(value: unknown): DatasetRef | undefined {
  let candidate = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (
    candidate &&
    typeof candidate === 'object' &&
    (candidate as { kind?: unknown }).kind === 'dataset'
  ) {
    return candidate as DatasetRef;
  }
  return undefined;
}

type SqlPlan = { sql: string; params: unknown[] } | { error: { status: number; message: string } };

/** What a step handed a handle addresses the upstream rows by. */
const SOURCE_ALIAS = 'source';

/** True when the step asks for anything narrower than the whole handle. */
function narrows(config: DataNodeConfig): boolean {
  return Boolean(
    (config.where && config.where.length > 0) ||
      (config.orderBy && config.orderBy.length > 0) ||
      (typeof config.limit === 'number' && config.limit > 0) ||
      ((config.tables ?? [])[0]?.columns ?? []).length > 0,
  );
}

/**
 * Reading a dataset handle, optionally narrowed. Search and filter push DOWN
 * into the upstream query rather than pulling every row back to compare here:
 * the point of a handle is that the rows never had to travel.
 */
function resolveFromHandle(ref: DatasetRef, config: DataNodeConfig, engine: string): SqlPlan {
  if (!ref.query) return { error: { status: 400, message: 'the dataset reference has no query to run' } };
  // Checked before anything else, because both paths below would swallow it:
  // defaulting the operation to select turns a delete into a read, and a write
  // with no filter looks like "narrows nothing" and just opens the handle.
  if (WRITE_OPS.has((config.operation ?? '').toLowerCase())) {
    return {
      error: { status: 400, message: 'a dataset reference can only be read from, not written through' },
    };
  }
  // Hand-written SQL alongside a handle is ambiguous: there is no way to tell
  // whether it replaces the upstream query or runs over it. It used to be
  // dropped without a word, so a step that looked filtered returned everything.
  if (config.query && config.query.trim() !== '') {
    return {
      error: {
        status: 400,
        message:
          'this step reads a dataset reference, so its own query cannot also run. ' +
          `Filter the reference with the builder (it is available as "${SOURCE_ALIAS}"), ` +
          'or drop the reference to run the query on its own.',
      },
    };
  }
  if (!narrows(config)) return { sql: ref.query, params: [] };
  try {
    const built = buildQuery({ ...config, operation: config.operation ?? 'select' }, dialectFor(engine), {
      sql: ref.query,
      alias: SOURCE_ALIAS,
    });
    return { sql: built.query, params: built.params };
  } catch (error) {
    return { error: { status: 400, message: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * The SQL to run: a handle's query (narrowed by this step's filter if it has
 * one), else the raw query, else the visual table builder. Returns a 400 plan
 * when the configuration cannot mean one thing.
 */
function resolveSql(ref: DatasetRef | undefined, config: DataNodeConfig, engine: string): SqlPlan {
  if (ref) return resolveFromHandle(ref, config, engine);
  if (config.query && config.query.trim() !== '') {
    return { sql: config.query, params: (config.params ?? []) as unknown[] };
  }
  if (config.operation) {
    try {
      // Metis generates builder SQL, so it must be the target engine's own
      // dialect: MySQL quotes with backticks and binds with `?`.
      const built = buildQuery(config, dialectFor(engine));
      return { sql: built.query, params: built.params };
    } catch (error) {
      return { error: { status: 400, message: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { error: { status: 400, message: 'the data step needs a query or a table operation' } };
}

export function createDataNodeHandler(
  sources: DataSourceRegistry,
  credentials: CredentialPort,
): NodeHandler {
  return async (ctx) => {
    const config = ctx.nodeRef.config as DataNodeConfig;

    // Materialise-on-read: a reference handed in by an earlier step fully
    // determines the connection + query (a later step "opening" an earlier
    // step's handle).
    const ref = asDatasetRef(config.sourceRef);

    const connectionId = String(ref?.connectionId ?? config.connectorId ?? config.connectionId ?? '');
    if (!connectionId) return { status: 400, message: 'the data step needs a connection' };

    // A node named after an engine IS that engine, exactly as a connector
    // node's type names its connector. The generic `data`/`sql` types carry no
    // engine of their own, so those fall back to the config or to postgres.
    const typedEngine = NAMED_ENGINE_NODES.has(ctx.nodeRef.type) ? ctx.nodeRef.type : undefined;
    const engine = String(ref?.engine ?? typedEngine ?? config.engine ?? 'postgres');
    const source = sources.get(engine);
    if (!source) {
      return {
        status: 400,
        message: `the "${engine}" data source is available in Helix`,
        nodeData: { code: 'engine-locked' },
      };
    }

    const plan = resolveSql(ref, config, engine);
    if ('error' in plan) return plan.error;
    const { sql, params } = plan;

    // Produce a reference instead of rows: a small handle that dodges the payload
    // ceiling and is the shape warehouse-scale engines return. Reads only - deferring a
    // write would silently re-run it when a later step materialises the handle.
    if (!ref && config.output === 'reference') {
      if (WRITE_OPS.has((config.operation ?? '').toLowerCase())) {
        return { status: 400, message: 'a dataset reference can only be made for a read (select) query' };
      }
      const dataset: DatasetRef = { kind: 'dataset', connectionId, engine, query: sql };
      return {
        status: 200,
        message: 'ok',
        nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, { dataset }),
      };
    }

    let material: Record<string, string>;
    try {
      material = await credentials.resolveConnectorCredentials(ctx.tenantId, connectionId);
    } catch {
      return {
        status: 500,
        message: `could not resolve credentials for connection "${connectionId}"`,
        nodeData: { code: 'credentials' },
      };
    }

    try {
      const result = await source.runQuery(
        { key: `${ctx.tenantId}/${connectionId}`, material },
        sql,
        { params },
      );
      return {
        status: 200,
        message: 'ok',
        nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, withFirstRow(result)),
      };
    } catch (error) {
      return { status: 500, message: error instanceof Error ? error.message : String(error) };
    }
  };
}
