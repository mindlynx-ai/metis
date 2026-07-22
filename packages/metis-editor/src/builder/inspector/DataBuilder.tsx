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
 * The Data node's "how to get data" region: a mode toggle between writing SQL
 * and building a query visually (pick a table, an operation, filters, values) -
 * so a non-technical user never has to write SQL. The visual builder lists the
 * connection's real tables (via /api/data/tables); an engine that ships only in
 * Helix, or an unreachable database, falls back to a typed table name. It owns
 * the config keys the handler reads (query in SQL mode; operation/tables/where
 * in build mode) and clears the other side so the two never both apply.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api, type WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import { Modal } from './Modal.js';
import {
  columnsToOutputs,
  filterTables,
  NEEDS_VALUES,
  NEEDS_WHERE,
  outputsKey,
  seedFrom,
  toDataConfig,
  type BuilderState,
  type DataColumn,
  type ValueRow,
  type WhereRow,
} from './data-builder-config.js';

const OPERATIONS = [
  { value: 'select', label: 'Select (read rows)' },
  { value: 'insert', label: 'Insert (add a row)' },
  { value: 'update', label: 'Update (change rows)' },
  { value: 'delete', label: 'Delete (remove rows)' },
];
const OPERATORS = ['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'ILIKE'];

export function DataBuilder({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const config = (node.data?.config ?? {}) as Record<string, unknown>;
  const connectionId = String(config.connectorId ?? '');

  const [state, setState] = useState<BuilderState>(() => seedFrom(config));
  const [tables, setTables] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [search, setSearch] = useState('');
  const [validation, setValidation] = useState<{
    status: 'idle' | 'checking' | 'ok' | 'error';
    columns?: DataColumn[];
    error?: string;
  }>({ status: 'idle' });

  // Reseed when a different node is selected.
  useEffect(() => {
    setState(seedFrom((node.data?.config ?? {}) as Record<string, unknown>));
    setValidation({ status: 'idle' });
  }, [node.id]);

  // Publish a validated column set as the node's output variables, so a
  // downstream step (a Switch condition, a Resend field) can pick row.<col>.
  // Skip a no-op write so opening a node never marks it dirty.
  const publishColumns = (columns: DataColumn[]) => {
    const desired = columnsToOutputs(columns);
    if (outputsKey(desired) !== outputsKey(node.data?.outputs)) flow.updateOutputs(node.id, desired);
  };

  // SQL mode: validate the hand-written query (joins and all) and expose its
  // columns. A bad column/join comes back as the database's own message.
  const validate = async () => {
    if (!connectionId || state.query.trim() === '') return;
    setValidation({ status: 'checking' });
    try {
      const result = await api.validateQuery(connectionId, state.query);
      if (result.locked) {
        setValidation({ status: 'error', error: 'Validation for this engine is available in the Helix edition.' });
      } else if (result.valid) {
        setValidation({ status: 'ok', columns: result.columns });
        publishColumns(result.columns ?? []);
      } else {
        setValidation({ status: 'error', error: result.error ?? 'invalid query' });
      }
    } catch {
      setValidation({ status: 'error', error: 'could not reach the database' });
    }
  };

  // Build mode: the chosen table's columns ARE the output variables; fetch them
  // when the table changes (no Validate button - a built query is always valid).
  useEffect(() => {
    if (state.mode !== 'build' || !connectionId || !state.table) return undefined;
    let live = true;
    api
      .dataColumns(connectionId, state.table)
      .then((result) => {
        if (live && result.columns?.length) {
          publishColumns(result.columns);
          setValidation({ status: 'ok', columns: result.columns });
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [state.mode, state.table, connectionId]);

  // The connection's real tables (build mode's dropdown). Locked / unreachable
  // engines leave the list empty and the table falls back to a typed name.
  useEffect(() => {
    if (!connectionId) {
      setTables([]);
      setLocked(false);
      return undefined;
    }
    let live = true;
    api
      .dataTables(connectionId)
      .then((result) => {
        if (!live) return;
        setTables((result.tables ?? []).map((table) => table.name));
        setLocked(Boolean(result.locked));
      })
      .catch(() => {
        if (live) {
          setTables([]);
          setLocked(false);
        }
      });
    return () => {
      live = false;
    };
  }, [connectionId]);

  // Commit the derived config keys in one update, preserving the node's other
  // fields (connection, output, source reference).
  const commit = (next: BuilderState) => {
    setState(next);
    const base = { ...((node.data?.config ?? {}) as Record<string, unknown>) };
    for (const key of ['query', 'operation', 'tables', 'where', 'mode']) delete base[key];
    for (const [key, value] of Object.entries(toDataConfig(next))) {
      if (value !== undefined) base[key] = value;
    }
    flow.updateConfig(node.id, base);
  };

  const setWhere = (rows: WhereRow[]) => commit({ ...state, where: rows });
  const setValues = (rows: ValueRow[]) => commit({ ...state, values: rows });

  return (
    <div className="data-builder" data-field="dataBuilder">
      <div className="seg" role="tablist" aria-label="How to get data">
        <button
          type="button"
          role="tab"
          aria-selected={state.mode === 'sql'}
          className={`seg-btn${state.mode === 'sql' ? ' active' : ''}`}
          onClick={() => commit({ ...state, mode: 'sql' })}
        >
          Write SQL
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.mode === 'build'}
          className={`seg-btn${state.mode === 'build' ? ' active' : ''}`}
          onClick={() => commit({ ...state, mode: 'build' })}
        >
          Build a query
        </button>
      </div>

      {state.mode === 'sql' ? (
        <div className="field">
          <label htmlFor="data-query">SQL query</label>
          <textarea
            id="data-query"
            className="mono"
            rows={5}
            value={state.query}
            placeholder="select * from orders where amount > $1"
            onChange={(event) => commit({ ...state, query: event.target.value })}
          />
          <p className="help">Its rows become this step&apos;s output. Use $1, $2 for parameter values.</p>
          <div className="validate-row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={validate}
              disabled={!connectionId || state.query.trim() === '' || validation.status === 'checking'}
            >
              {validation.status === 'checking' ? 'Validating' : 'Validate'}
            </button>
            {validation.status === 'ok' && validation.columns && (
              <span className="validate-ok" role="status">
                Valid - outputs {validation.columns.map((column) => column.name).join(', ')}
              </span>
            )}
            {validation.status === 'error' && (
              <span className="validate-err" role="alert">
                {validation.error}
              </span>
            )}
          </div>
          {!connectionId && <p className="help">Pick a connection to validate.</p>}
        </div>
      ) : (
        <div className="build-form">
          <div className="field">
            <label htmlFor="data-op">Operation</label>
            <select
              id="data-op"
              value={state.operation}
              onChange={(event) => commit({ ...state, operation: event.target.value })}
            >
              {OPERATIONS.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="data-table">Table</label>
            <div className="table-field">
              {tables.length > 0 ? (
                <select
                  id="data-table"
                  value={state.table}
                  onChange={(event) => commit({ ...state, table: event.target.value })}
                >
                  <option value="">Choose a table</option>
                  {tables.map((table) => (
                    <option key={table} value={table}>
                      {table}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="data-table"
                  value={state.table}
                  placeholder="orders"
                  onChange={(event) => commit({ ...state, table: event.target.value })}
                />
              )}
              {tables.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => setBrowsing(true)}>
                  Browse
                </button>
              )}
            </div>
            {locked && (
              <p className="help">This engine&apos;s tables are browsable in the Helix edition - type the table name here.</p>
            )}
            {!connectionId && <p className="help">Pick a connection to list its tables.</p>}
          </div>

          {browsing && (
            <Modal title="Choose a table" onClose={() => setBrowsing(false)}>
              <input
                className="search"
                placeholder={`Search ${tables.length} tables`}
                aria-label="Search tables"
                value={search}
                autoFocus
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="table-list">
                {filterTables(tables, search).map((table) => (
                  <button
                    key={table}
                    type="button"
                    className={`table-item${table === state.table ? ' is-on' : ''}`}
                    onClick={() => {
                      commit({ ...state, table });
                      setBrowsing(false);
                      setSearch('');
                    }}
                  >
                    {table}
                  </button>
                ))}
                {filterTables(tables, search).length === 0 && (
                  <p className="help">No tables match &ldquo;{search.trim()}&rdquo;.</p>
                )}
              </div>
            </Modal>
          )}

          {NEEDS_VALUES.has(state.operation) && (
            <RowEditor
              label="Values"
              addLabel="Add a value"
              rows={state.values}
              blank={{ column: '', value: '' }}
              render={(row, patch) => (
                <>
                  <input
                    className="kv-key"
                    value={row.column}
                    placeholder="column"
                    onChange={(event) => patch({ column: event.target.value })}
                  />
                  <input
                    className="kv-val"
                    value={row.value}
                    placeholder="value"
                    onChange={(event) => patch({ value: event.target.value })}
                  />
                </>
              )}
              onChange={setValues}
            />
          )}

          {NEEDS_WHERE.has(state.operation) && (
            <RowEditor
              label={state.operation === 'select' ? 'Filters (optional)' : 'Which rows (required)'}
              addLabel="Add a filter"
              rows={state.where}
              blank={{ column: '', operator: '=', value: '' }}
              render={(row, patch) => (
                <>
                  <input
                    className="kv-key"
                    value={row.column}
                    placeholder="column"
                    onChange={(event) => patch({ column: event.target.value })}
                  />
                  <select
                    className="kv-op"
                    value={row.operator}
                    onChange={(event) => patch({ operator: event.target.value })}
                  >
                    {OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </select>
                  <input
                    className="kv-val"
                    value={row.value}
                    placeholder="value"
                    onChange={(event) => patch({ value: event.target.value })}
                  />
                </>
              )}
              onChange={setWhere}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** A small add/remove list of typed rows, shared by the filters + values editors. */
function RowEditor<T>({
  label,
  addLabel,
  rows,
  blank,
  render,
  onChange,
}: {
  label: string;
  addLabel: string;
  rows: T[];
  blank: T;
  render: (row: T, patch: (change: Partial<T>) => void) => ReactNode;
  onChange: (rows: T[]) => void;
}) {
  return (
    <div className="row-editor">
      <span className="op-extra-label">{label}</span>
      <div className="kv-editor">
        {rows.map((row, index) => (
          <div className="kv-row" key={index}>
            {render(row, (change) => onChange(rows.map((r, i) => (i === index ? { ...r, ...change } : r))))}
            <button
              type="button"
              className="btn btn-sm kv-remove"
              aria-label="Remove"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => onChange([...rows, { ...blank }])}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}
