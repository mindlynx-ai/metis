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
 * chosen connection's id into the node's `connectorId` config field.
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
  const chosenConnectionId = String(config.connectorId ?? '');
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
          onChange={(event) => set('connectorId', event.target.value || undefined)}
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
              set('connectorId', id);
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
