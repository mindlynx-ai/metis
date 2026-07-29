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
 * The connection picker (the `connectorRef` widget). A typed node (sendgrid,
 * postgres, ...) references ONE connection of its own provider - it does NOT
 * pick a connector type (that is fixed by the node type; picking node types is
 * the palette's job). This lists the tenant's connections for the node's
 * provider and lets you pick one or create a new named one inline, writing the
 * chosen connection's id into the node's `connectorId` config field - plus, for
 * a data source, which engine that connection is, since nothing downstream can
 * work it out from the id alone.
 */
import { useEffect, useState } from 'react';
import {
  api,
  type ConnectionRecord,
  type ConnectorDef,
  type WorkflowNode,
} from '../../api.js';
import { HEALTH_LABEL, useConnectionTest } from '../../connectors/health.js';
import { useFlow } from '../../flow-store.js';
import { ConnectorConnectForm } from './ConnectorConnectForm.js';
import { Modal } from './Modal.js';
import { type ConnectorScope } from './connector-scope.js';
import { loadConnectors } from './connectors-cache.js';

export function ConnectorPicker({ node, scope = {} }: { node: WorkflowNode; scope?: ConnectorScope }) {
  const flow = useFlow();
  const [connectors, setConnectors] = useState<ConnectorDef[]>([]);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [oauthSet, setOauthSet] = useState<Set<string>>(new Set());
  const [showConnect, setShowConnect] = useState(false);
  const { health, setHealth, test } = useConnectionTest();

  const refresh = () =>
    api
      .connections()
      .then((result) => setConnections(result.connections))
      .catch(() => setConnections([]));

  useEffect(() => {
    let live = true;
    loadConnectors().then((list) => {
      if (live) setConnectors(list);
    });
    void refresh();
    api
      .oauthCapable()
      .then((result) => live && setOauthSet(new Set(result.connectors)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const config = node.data?.config ?? {};
  // The connectorId field on a typed node holds the chosen CONNECTION id.
  // `connectionId` is the clearer name the runtime also honours, so a flow
  // authored through the API with it must not read here as "no connection".
  const chosenConnectionId = String(config.connectionId ?? config.connectorId ?? '');
  const provider = scope.provider ?? '';

  // The connector TYPE this node binds (fixed by the node's ?provider hint):
  // used for the new-connection form's auth scheme + a friendly name.
  const providerDef = connectors.find((c) => c.connectorId === provider);
  const matching = connections
    .filter((c) => c.connectorId === provider)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const isOAuth = oauthSet.has(provider);
  const set = (key: string, value: unknown) => flow.updateConfigField(node.id, key, value);

  /**
   * A database connection IS its engine, and the picker is the only place that
   * knows which one was chosen. The Data step's `engine` field was documented
   * as the inspector's to write, and nothing ever wrote it: the runtime fell
   * back to guessing postgres, and a step bound to the cloud could not be told
   * apart from one aimed at the cloud's own warehouse. Recorded for data
   * sources only, because nothing else reads it.
   *
   * Both facts are consulted so the write cannot be lost to a load order: the
   * connector catalogue answers for a connection made through the modal, the
   * chosen record for one picked from the list (the same fetch that filled it).
   */
  const isDataSource = (connectionId: string): boolean =>
    providerDef?.authScheme === 'database' ||
    connections.find((c) => c.connectionId === connectionId)?.connectionType === 'database';

  /** Pick a connection, keeping one source of truth: a stale `connectionId`
   *  left beside a new `connectorId` would win at run time and authenticate as
   *  whatever was chosen before. */
  const choose = (connectionId: string | undefined) => {
    set('connectorId', connectionId);
    if (provider && isDataSource(connectionId ?? '')) {
      set('engine', connectionId ? provider : undefined);
    }
    if (config.connectionId !== undefined) set('connectionId', undefined);
  };

  // Reset the health readout whenever the chosen connection changes.
  useEffect(() => setHealth(undefined), [chosenConnectionId]);

  const testSelected = () => {
    if (!chosenConnectionId) return;
    void test(() => api.testConnection(chosenConnectionId));
  };

  return (
    <div className="connector-picker">
      <div className="field" data-field="connectorId">
        <label htmlFor="conn-conn">Connection</label>
        <select
          id="conn-conn"
          value={chosenConnectionId}
          onChange={(event) => choose(event.target.value || undefined)}
        >
          <option value="">
            {matching.length ? 'Choose a connection' : 'No connections yet'}
          </option>
          {matching.map((c) => (
            <option key={c.connectionId} value={c.connectionId}>
              {c.name}
            </option>
          ))}
        </select>

        <div className="conn-picker-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowConnect(true)}
            disabled={!providerDef}
          >
            + New connection
          </button>
          {chosenConnectionId && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={testSelected}
              disabled={health === 'testing'}
            >
              {health === 'testing' ? 'Testing…' : 'Test'}
            </button>
          )}
          {health && health !== 'testing' && (
            <span
              className={`conn-badge ${health.ok ? 'conn-ok' : 'conn-warn'}`}
              title={health.message}
            >
              {HEALTH_LABEL[health.status]}
            </span>
          )}
        </div>

        {!providerDef && connectors.length > 0 && (
          <div className="help">No connector type is configured for this step.</div>
        )}
      </div>

      {providerDef && showConnect && (
        <Modal title={`New ${providerDef.name} connection`} onClose={() => setShowConnect(false)}>
          <ConnectorConnectForm
            connector={providerDef}
            oauth={isOAuth}
            onConnected={(id) => {
              choose(id);
              setShowConnect(false);
              void refresh();
            }}
            onCancel={() => setShowConnect(false)}
          />
        </Modal>
      )}
    </div>
  );
}
