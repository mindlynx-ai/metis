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
 * The connect form used from the builder's connection picker: the credential
 * fields a connector needs (its own schema, else its auth scheme), tested
 * live and saved as a named connection. Credentials are write-only from the
 * UI (never fetched back); a "none" connector needs nothing.
 */
import { useState } from 'react';
import { api, ApiError, type ConnectorDef } from '../../api.js';
import { CredentialInputs } from '../../connectors/CredentialInputs.js';
import { credentialFields } from '../../connectors/credential-fields.js';
import { HEALTH_LABEL, useConnectionTest } from '../../connectors/health.js';

export function ConnectorConnectForm({
  connector,
  oauth,
  onConnected,
  onCancel,
}: {
  connector: ConnectorDef;
  /** When true, connect via the OAuth redirect flow instead of a key form. */
  oauth?: boolean;
  /** Called with the new connection's id once it is created. */
  onConnected(connectionId: string): void;
  onCancel?(): void;
}) {
  const fields = credentialFields(connector);
  const [name, setName] = useState(connector.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { health, test } = useConnectionTest();

  const testEntered = () => {
    setError(undefined);
    return test(() =>
      api.testConnectionMaterial({
        connectorId: connector.connectorId,
        authScheme: connector.authScheme,
        baseUrl: connector.baseUrl,
        material: values,
      }),
    );
  };

  const startOAuth = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { authorizeUrl } = await api.oauthStart(connector.connectorId);
      // Hand off to the provider; the callback returns to /connectors.
      window.location.href = authorizeUrl;
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'could not start the OAuth flow');
      setBusy(false);
    }
  };

  if (oauth) {
    return (
      <div className="connect-form">
        <p className="help">Connect your {connector.name} account securely with OAuth.</p>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="connect-form-actions">
          {onCancel && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={startOAuth} disabled={busy}>
            {busy ? 'Redirecting' : `Connect with ${connector.name}`}
          </button>
        </div>
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // Create a named connection (instance) for this connector type; a "none"
      // connector still gets an (empty) connection so a node can reference it.
      const record = await api.createConnection({
        name: name.trim() || connector.name,
        connectorId: connector.connectorId,
        authScheme: connector.authScheme,
        baseUrl: connector.baseUrl,
        material: values,
      });
      onConnected(record.connectionId);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'could not save the connection');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-form">
      <div className="field">
        <label htmlFor="conn-name">Connection name</label>
        <input
          id="conn-name"
          value={name}
          placeholder={connector.name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <CredentialInputs
        fields={fields}
        values={values}
        onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
        idPrefix="cred"
      />
      {health && health !== 'testing' && (
        <p className={`connect-test ${health.ok ? 'ok' : 'bad'}`} role="status">
          <span className={`conn-badge ${health.ok ? 'conn-ok' : 'conn-warn'}`}>
            {HEALTH_LABEL[health.status]}
          </span>
          {health.message ? ` ${health.message}` : ''}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="connect-form-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        {fields.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void testEntered()}
            disabled={busy || health === 'testing'}
          >
            {health === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {busy ? 'Creating' : 'Create'}
        </button>
      </div>
    </div>
  );
}
