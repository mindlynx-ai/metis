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
  asDatasetRef,
  narrowsHandle,
  stateEnvelope,
  type CredentialPort,
  type DatasetNarrow,
  type DatasetRef,
  type DataSourceRegistry,
  type NodeHandler,
  type QueryResult,
} from '@mindlynx/metis-ports';
import { buildQuery, dialectFor, type BuiltQuery, type PgBuilderConfig } from './postgres-query.js';

interface DataNodeConfig extends PgBuilderConfig {
  /** The chosen connection instance id (material is resolved from this). */
  connectorId?: string;
  connectionId?: string;
  /** The connection's engine, recorded by the picker when the connection is
   *  chosen. A flow saved before that carries none, hence the postgres fallback. */
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

type SqlPlan = { sql: string; params: unknown[] } | { error: { status: number; message: string } };

/** What a step handed a handle addresses the upstream rows by. */
const SOURCE_ALIAS = 'source';

/** Run the builder, turning its "this config cannot mean one thing" throw into
 *  the 400 the step reports. */
function compose(build: () => BuiltQuery): SqlPlan {
  try {
    const built = build();
    return { sql: built.query, params: built.params };
  } catch (error) {
    return { error: { status: 400, message: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * The handle's narrowing plus this step's, as one builder config. The narrower of
 * the two wins throughout, because a step opening a handle can only ever ask for
 * LESS than the handle already describes:
 *
 * - columns: the step's list REPLACES the handle's (a union would return more
 *   than the step asked for, which is not narrowing).
 * - where: both, ANDed, the handle's first so params bind in reading order.
 * - orderBy: the step's replaces the handle's - it is the outer sort.
 * - limit: the tighter of the two.
 *
 * One deliberate difference from the derived-table path: a flat statement filters
 * the table and then caps, where a wrapped query would have capped first and
 * filtered those rows. A flat SELECT cannot express "the first N rows, then
 * filtered", and a flat SELECT is the only shape a tenant-scoping engine accepts,
 * so the merged reading is "the filtered rows, capped at N".
 */
function mergedSpec(ref: DatasetRef, config: DataNodeConfig): PgBuilderConfig {
  const narrow = ref.narrow ?? {};
  const stepColumns = (config.tables ?? [])[0]?.columns;
  const caps = [narrow.limit, config.limit].filter((cap): cap is number => typeof cap === 'number' && cap > 0);
  const stepOrder = config.orderBy && config.orderBy.length > 0 ? config.orderBy : undefined;
  return {
    operation: 'select',
    tables: [{ name: String(ref.table), columns: stepColumns ?? narrow.columns }],
    where: [...(narrow.where ?? []), ...(config.where ?? [])],
    orderBy: stepOrder ?? narrow.orderBy,
    limit: caps.length > 0 ? Math.min(...caps) : undefined,
  };
}

/**
 * Reading a dataset handle, optionally narrowed. Search and filter push DOWN
 * into the source rather than pulling every row back to compare here: the point
 * of a handle is that the rows never had to travel.
 *
 * Which shape that push-down takes is the handle's form (see DatasetRef). A SPEC
 * handle composes ONE flat statement from the merged ingredients - never a
 * derived table, because the same handle has to be readable by an engine that
 * refuses subqueries outright to keep every query provably account-scoped. A RAW
 * handle has only its SQL, so narrowing it means wrapping it, which works here
 * and is refused before a cloud dispatch rather than silently unfiltered.
 */
function resolveFromHandle(ref: DatasetRef, config: DataNodeConfig, engine: string): SqlPlan {
  // Checked before anything else, because every path below would swallow it:
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
  if (ref.table) return compose(() => buildQuery(mergedSpec(ref, config), dialectFor(engine)));
  const upstream = ref.query;
  if (!upstream) return { error: { status: 400, message: 'the dataset reference has no query to run' } };
  if (!narrowsHandle(config)) return { sql: upstream, params: [] };
  return compose(() =>
    buildQuery({ ...config, operation: config.operation ?? 'select' }, dialectFor(engine), {
      sql: upstream,
      alias: SOURCE_ALIAS,
    }),
  );
}

/** The step's own narrowing, as a handle carries it. Undefined when the step asks
 *  for the whole table, because an absent `narrow` is what "no narrowing" means. */
function narrowFor(config: DataNodeConfig): DatasetNarrow | undefined {
  if (!narrowsHandle(config)) return undefined;
  const columns = (config.tables ?? [])[0]?.columns;
  return {
    ...(columns && columns.length > 0 ? { columns } : {}),
    ...(config.where && config.where.length > 0 ? { where: config.where } : {}),
    ...(config.orderBy && config.orderBy.length > 0 ? { orderBy: config.orderBy } : {}),
    ...(typeof config.limit === 'number' && config.limit > 0 ? { limit: config.limit } : {}),
  };
}

/**
 * The handle to hand on, in whichever of the two forms is honest about what this
 * step actually knows (see DatasetRef for the forms).
 *
 * SPEC whenever the step was authored with the visual builder: the ingredients,
 * not the SQL. Only that form can be narrowed by a later step everywhere, because
 * narrowing SQL means wrapping it, and an engine that has to prove every query is
 * account-scoped refuses a subquery outright.
 *
 * RAW for hand-written SQL, because the query IS all we know about it.
 *
 * A qualified name keeps it RAW as well: `table` carries no database or schema,
 * so a spec handle for a step naming either would resolve to the default schema's
 * table of that name - a different table, no error. The composed SQL already has
 * the qualified name in it, so the raw form loses nothing but the filtering.
 */
function datasetFor(connectionId: string, engine: string, config: DataNodeConfig, sql: string): DatasetRef {
  const tables = config.tables ?? [];
  const table = tables[0]?.name;
  const authoredVisually =
    Boolean(config.operation) &&
    tables.length === 1 &&
    table !== undefined &&
    (config.query ?? '').trim() === '' &&
    config.database === undefined &&
    config.schema === undefined;
  if (!authoredVisually) return { kind: 'dataset', connectionId, engine, query: sql };
  const narrow = narrowFor(config);
  return { kind: 'dataset', connectionId, engine, table, ...(narrow ? { narrow } : {}) };
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
    if (!connectionId) {
      // A handle naming no connection came from a step that ran in the cloud,
      // where the account supplies the warehouse and there is nothing to name.
      // It deliberately does NOT fall back to this step's own connection: the
      // warehouse's table name run against the user's own database would read a
      // different table and never say so.
      if (ref) {
        return {
          status: 400,
          message:
            'this dataset reference came from a step that ran in the cloud, so it carries no ' +
            'connection to open it with, and this step\'s own connection is a different data ' +
            'source. Set "Where it runs" on this step to the cloud as well.',
          nodeData: { code: 'reference-connection' },
        };
      }
      return { status: 400, message: 'the data step needs a connection' };
    }

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
      // The SQL above is composed even for a spec handle, and then thrown away:
      // it is how a builder config that cannot mean one thing still fails here,
      // at the step that wrote it, rather than at whichever step opens it later.
      const dataset = datasetFor(connectionId, engine, config, sql);
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
