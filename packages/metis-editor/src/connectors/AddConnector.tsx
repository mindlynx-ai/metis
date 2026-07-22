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
 * Connect a service (or a REST/DB/M2M endpoint): pick a class, browse the
 * catalogue for a service, fill its real credential fields, test, create.
 */
import { useMemo, useState } from 'react';
import { api, type ConnectorDef, type CredentialFieldDef } from '../api.js';
import { buildInput, CLASSES, type ConnClass } from './build-input.js';
import { ConnMark } from './ConnMark.js';
import { CredentialInputs } from './CredentialInputs.js';
import { credentialFields, fieldsForScheme } from './credential-fields.js';
import { useConnectionTest } from './health.js';
import { TestRow } from './TestRow.js';

/** The searchable, branded catalogue grid for picking a service. */
function ServicePicker({
  connectors,
  onPick,
}: {
  connectors: ConnectorDef[];
  onPick(service: ConnectorDef): void;
}) {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const sorted = connectors.slice().sort((a, b) => a.name.localeCompare(b.name));
    return query ? sorted.filter((c) => c.name.toLowerCase().includes(query)) : sorted;
  }, [connectors, q]);
  return (
    <div className="svc-pick">
      <input
        className="svc-search"
        placeholder={`Search ${connectors.length} services…`}
        aria-label="Search services"
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      <div className="svc-grid" role="list">
        {results.map((c) => (
          <button
            key={c.connectorId}
            type="button"
            role="listitem"
            className="svc-tile"
            onClick={() => onPick(c)}
          >
            <ConnMark name={c.name} color={c.brandColor} />
            <span className="svc-name">{c.name}</span>
          </button>
        ))}
        {results.length === 0 && <p className="help">No service matches “{q}”.</p>}
      </div>
    </div>
  );
}

const REST_FIELDS: Record<string, CredentialFieldDef[]> = {
  api_key: [{ key: 'apiKey', label: 'API key', secret: true, required: true }],
  basic: [
    { key: 'user', label: 'Username', required: true },
    { key: 'password', label: 'Password', secret: true, required: true },
  ],
  bearer: [{ key: 'token', label: 'Bearer token', secret: true, required: true }],
};

const M2M_FIELDS: CredentialFieldDef[] = [
  { key: 'tokenUrl', label: 'Token URL', required: true, placeholder: 'https://auth.example.com/oauth/token' },
  { key: 'clientId', label: 'Client ID', required: true },
  { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
  { key: 'scopes', label: 'Scopes', placeholder: 'read write' },
];

export function AddConnector({
  connectors,
  onCreated,
  onCancel,
}: {
  connectors: ConnectorDef[];
  onCreated(): void;
  onCancel(): void;
}) {
  const [connClass, setConnClass] = useState<ConnClass>('service');
  const [service, setService] = useState<ConnectorDef>();
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({ authMethod: 'bearer', engine: 'postgres' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { health, setHealth, test } = useConnectionTest();

  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const pickClass = (key: ConnClass) => {
    setConnClass(key);
    setService(undefined);
    setHealth(undefined);
  };
  const pickService = (svc: ConnectorDef) => {
    setService(svc);
    setName((current) => current || svc.name);
    setHealth(undefined);
  };

  const payload = () => buildInput(connClass, name.trim() || service?.name || '', values, service);

  const testEntered = () =>
    test(() => {
      const input = payload();
      return api.testConnectionMaterial({
        connectorId: input.connectorId,
        authScheme: input.authScheme,
        baseUrl: input.baseUrl,
        material: input.material,
      });
    });

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.createConnection(payload());
      onCreated();
    } catch {
      setError('could not create the connection');
      setBusy(false);
    }
  };

  const restFields = REST_FIELDS[values.authMethod] ?? REST_FIELDS.bearer;
  const canSave = name.trim() !== '' && !busy && (connClass !== 'service' || service !== undefined);

  return (
    <div className="conn-form" role="group" aria-label="Connect a service">
      <div className="conn-classes" role="tablist" aria-label="Connection type">
        {CLASSES.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={connClass === c.key}
            className={`conn-class${connClass === c.key ? ' active' : ''}`}
            onClick={() => pickClass(c.key)}
          >
            <span className="conn-class-label">{c.label}</span>
            <span className="conn-class-hint">{c.hint}</span>
          </button>
        ))}
      </div>

      {connClass === 'service' && !service ? (
        <ServicePicker connectors={connectors} onPick={pickService} />
      ) : (
        <div className="conn-form-body">
          {connClass === 'service' && service && (
            <div className="conn-chosen">
              <ConnMark name={service.name} color={service.brandColor} size="lg" />
              <div>
                <div className="conn-chosen-name">{service.name}</div>
                <div className="conn-chosen-url">{service.baseUrl}</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm conn-change" onClick={() => setService(undefined)}>
                Change
              </button>
            </div>
          )}

          <div className="field">
            <label htmlFor="add-name">Connection name</label>
            <input
              id="add-name"
              value={name}
              placeholder={service ? `${service.name} (production)` : 'e.g. Production'}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {connClass === 'service' && service && (
            <CredentialInputs fields={credentialFields(service)} values={values} onChange={set} idPrefix="add" />
          )}

          {connClass === 'rest' && (
            <>
              <div className="field">
                <label htmlFor="add-baseUrl">Base URL</label>
                <input
                  id="add-baseUrl"
                  placeholder="https://api.example.com"
                  value={values.baseUrl ?? ''}
                  onChange={(event) => set('baseUrl', event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="add-authMethod">Authentication</label>
                <select id="add-authMethod" value={values.authMethod || 'bearer'} onChange={(e) => set('authMethod', e.target.value)}>
                  <option value="bearer">Bearer token</option>
                  <option value="api_key">API key header</option>
                  <option value="basic">Basic auth</option>
                </select>
              </div>
              <CredentialInputs fields={restFields} values={values} onChange={set} idPrefix="add" />
            </>
          )}

          {connClass === 'client_credentials' && (
            <CredentialInputs fields={M2M_FIELDS} values={values} onChange={set} idPrefix="add" />
          )}

          {connClass === 'database' && (
            <>
              <div className="field">
                <label htmlFor="add-engine">Engine</label>
                <select id="add-engine" value={values.engine || 'postgres'} onChange={(e) => set('engine', e.target.value)}>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="sqlserver">SQL Server</option>
                </select>
              </div>
              <CredentialInputs fields={fieldsForScheme('database')} values={values} onChange={set} idPrefix="add" />
            </>
          )}

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {(connClass !== 'service' || service) && (
        <div className="conn-form-foot">
          <TestRow health={health} onTest={() => void testEntered()} label="Test connection" />
          <div className="conn-form-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!canSave}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
