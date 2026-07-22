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
 * The Connectors surface: the tenant's CONNECTIONS as branded cards (or a
 * list) - each a named instance of a service with its own credentials and a
 * live health status. Connecting a service opens a modal that browses the
 * catalogue, shows that service's real credential fields, and tests them
 * before saving. Credentials are write-only; the list carries metadata +
 * health only.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type ConnectionRecord, type ConnectorDef } from './api.js';
import { Modal } from './builder/inspector/Modal.js';
import { AddConnector } from './connectors/AddConnector.js';
import { ConnMark } from './connectors/ConnMark.js';
import { EditConnector } from './connectors/EditConnector.js';
import { COULD_NOT_TEST, type HealthState } from './connectors/health.js';
import { HealthPill } from './connectors/HealthPill.js';
import { toast } from './toast-store.js';
import { ConfirmDialog } from './ui/ConfirmDialog.js';
import { Icon } from './ui/Icon.js';

type StatusFilter = 'all' | 'active' | 'attention';
type View = 'cards' | 'list';

/** The actions every connection row/card offers. */
function ConnActions({
  testing,
  onTest,
  onEdit,
  onRemove,
}: {
  testing: boolean;
  onTest(): void;
  onEdit(): void;
  onRemove(): void;
}) {
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={onTest} disabled={testing}>
        Test
      </button>
      <button type="button" className="btn btn-sm" onClick={onEdit}>
        Edit
      </button>
      <button type="button" className="btn btn-sm btn-danger-ghost" onClick={onRemove}>
        Remove
      </button>
    </>
  );
}

export function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorDef[]>();
  const [connections, setConnections] = useState<ConnectionRecord[]>();
  const [health, setHealth] = useState<Record<string, HealthState>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ConnectionRecord>();
  const [confirmRemove, setConfirmRemove] = useState<ConnectionRecord>();
  const [view, setView] = useState<View>(() =>
    (typeof localStorage !== 'undefined' && localStorage.getItem('metis-conn-view')) === 'list'
      ? 'list'
      : 'cards',
  );
  const chooseView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem('metis-conn-view', next);
    } catch {
      // ignore storage failures (private mode)
    }
  };

  const test = (connectionId: string) => {
    setHealth((current) => ({ ...current, [connectionId]: 'testing' }));
    return api
      .testConnection(connectionId)
      .then((result) => setHealth((current) => ({ ...current, [connectionId]: result })))
      .catch(() => setHealth((current) => ({ ...current, [connectionId]: COULD_NOT_TEST })));
  };

  const refresh = () =>
    api
      .connections()
      .then((result) => {
        setConnections(result.connections);
        result.connections.forEach((c) => void test(c.connectionId));
      })
      .catch(() => setConnections([]));

  useEffect(() => {
    api
      .connectors()
      .then((result) => setConnectors(result.connectors))
      .catch(() => setConnectors([]));
    void refresh();
  }, []);

  const byId = useMemo(() => new Map((connectors ?? []).map((c) => [c.connectorId, c])), [connectors]);

  const remove = async (connectionId: string) => {
    try {
      await api.deleteConnection(connectionId);
      toast.success('Connection removed');
    } catch {
      toast.error('Could not remove the connection');
    }
    void refresh();
  };

  const isActive = (connectionId: string): boolean => {
    const h = health[connectionId];
    return h !== undefined && h !== 'testing' && h.ok;
  };

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    return (connections ?? [])
      .filter((c) => q === '' || `${c.name} ${c.connectorId}`.toLowerCase().includes(q))
      .filter((c) => filter === 'all' || (filter === 'active' ? isActive(c.connectionId) : !isActive(c.connectionId)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [connections, query, filter, health]);

  const total = connections?.length ?? 0;
  const activeCount = (connections ?? []).filter((c) => isActive(c.connectionId)).length;
  const tabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: total },
    { key: 'active', label: 'Active', count: activeCount },
    { key: 'attention', label: 'Needs attention', count: total - activeCount },
  ];

  const subline = (conn: ConnectionRecord): string => {
    const def = byId.get(conn.connectorId);
    if (def && def.connectorId !== 'rest') return def.name;
    return conn.baseUrl || conn.connectorId;
  };
  const markColor = (conn: ConnectionRecord) => byId.get(conn.connectorId)?.brandColor;
  const actionsFor = (conn: ConnectionRecord) => ({
    testing: health[conn.connectionId] === 'testing',
    onTest: () => void test(conn.connectionId),
    onEdit: () => setEditing(conn),
    onRemove: () => setConfirmRemove(conn),
  });

  return (
    <main className="shell-main conn-page" aria-label="Connectors">
      <header className="page-hero">
        <div>
          <h1 className="page-title">Connectors</h1>
          <p className="page-hero-sub">
            A connector is a saved, secure connection to a service. Connect one, then any
            workflow step can use it - your credentials stay encrypted and never leave.
          </p>
        </div>
        <button type="button" className="btn btn-primary conn-connect-btn" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Connect a service
        </button>
      </header>

      <div className="conn-toolbar">
        <input
          className="connector-search"
          placeholder="Search your connections"
          aria-label="Search connections"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="conn-tabs" role="tablist" aria-label="Filter by status">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={filter === tab.key}
              className={`conn-tab${filter === tab.key ? ' active' : ''}`}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label} <span className="conn-tab-count">{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="conn-view" role="group" aria-label="View">
          <button
            type="button"
            className={`conn-view-btn${view === 'cards' ? ' active' : ''}`}
            aria-pressed={view === 'cards'}
            aria-label="Card view"
            onClick={() => chooseView('cards')}
          >
            <Icon name="grid" size={14} /> Cards
          </button>
          <button
            type="button"
            className={`conn-view-btn${view === 'list' ? ' active' : ''}`}
            aria-pressed={view === 'list'}
            aria-label="List view"
            onClick={() => chooseView('list')}
          >
            <Icon name="list" size={14} /> List
          </button>
        </div>
      </div>

      {total === 0 && (
        <div className="conn-empty">
          <div className="conn-empty-mark" aria-hidden="true">
            <Icon name="plug" size={28} />
          </div>
          <h2>No connections yet</h2>
          <p>Connect a service to give your workflows the keys they need.</p>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            Connect your first service
          </button>
        </div>
      )}

      {total > 0 && view === 'cards' && (
        <div className="conn-grid">
          {rows.map((conn) => (
            <article className="conn-card" key={conn.connectionId} data-connection={conn.connectorId}>
              <div className="conn-card-top">
                <ConnMark name={conn.name} color={markColor(conn)} size="lg" />
                <HealthPill health={health[conn.connectionId]} />
              </div>
              <div className="conn-card-body">
                <h3 className="conn-card-name">{conn.name}</h3>
                <p className="conn-card-sub">{subline(conn)}</p>
              </div>
              <div className="conn-card-actions">
                <ConnActions {...actionsFor(conn)} />
              </div>
            </article>
          ))}
          <button type="button" className="conn-card conn-card-add" onClick={() => setAdding(true)}>
            <span className="conn-card-add-plus" aria-hidden="true">
              <Icon name="plus" size={22} />
            </span>
            <span>Connect a service</span>
          </button>
        </div>
      )}

      {total > 0 && view === 'list' && (
        <div className="conn-list" role="table" aria-label="Connections">
          <div className="conn-lrow conn-lhead" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Service</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" className="conn-lrow-actions-head">
              Actions
            </span>
          </div>
          {rows.map((conn) => (
            <div className="conn-lrow" role="row" key={conn.connectionId} data-connection={conn.connectorId}>
              <div className="conn-lrow-name" role="cell">
                <ConnMark name={conn.name} color={markColor(conn)} />
                <span>{conn.name}</span>
              </div>
              <span className="conn-lrow-sub" role="cell">
                {subline(conn)}
              </span>
              <span role="cell">
                <HealthPill health={health[conn.connectionId]} />
              </span>
              <div className="conn-lrow-actions" role="cell">
                <ConnActions {...actionsFor(conn)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal title="Connect a service" onClose={() => setAdding(false)}>
          <AddConnector
            connectors={connectors ?? []}
            onCreated={() => {
              setAdding(false);
              toast.success('Connection saved');
              void refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(undefined)}>
          <EditConnector
            connection={editing}
            connector={byId.get(editing.connectorId)}
            onSaved={() => {
              setEditing(undefined);
              toast.success('Connection updated');
              void refresh();
            }}
            onCancel={() => setEditing(undefined)}
          />
        </Modal>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove "${confirmRemove.name}"?`}
          body="Steps using this connection will stop working until you reconnect the service."
          onConfirm={() => {
            void remove(confirmRemove.connectionId);
            setConfirmRemove(undefined);
          }}
          onCancel={() => setConfirmRemove(undefined)}
        />
      )}
    </main>
  );
}
