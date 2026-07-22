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
 * Edit a connection: rename and/or rotate any credential; test before saving.
 * Non-secret fields pre-fill with their current values; secrets stay blank
 * (write-only) and a blank secret keeps the stored value. Only changed fields
 * are sent; the server merges them.
 */
import { useEffect, useState } from 'react';
import { api, type ConnectionRecord, type ConnectorDef } from '../api.js';
import { CredentialInputs } from './CredentialInputs.js';
import { credentialFields, fieldsForScheme } from './credential-fields.js';
import { useConnectionTest } from './health.js';
import { TestRow } from './TestRow.js';

export function EditConnector({
  connection,
  connector,
  onSaved,
  onCancel,
}: {
  connection: ConnectionRecord;
  connector?: ConnectorDef;
  onSaved(): void;
  onCancel(): void;
}) {
  const fields = connector ? credentialFields(connector) : fieldsForScheme(connection.authScheme);
  const [name, setName] = useState(connection.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { health, test } = useConnectionTest();

  // Pre-fill the NON-SECRET fields (publishable key, host, port, ...) with their
  // current values so every field is present and editable; secrets stay blank.
  useEffect(() => {
    let live = true;
    api
      .getConnection(connection.connectionId)
      .then((result) => {
        if (!live) return;
        setValues(result.values);
        setOriginal(result.values);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connection.connectionId]);

  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const nonEmpty = () => Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));

  // If the user typed a new secret, preview the entered material; otherwise
  // test what is saved (which still holds the real secret).
  const testCurrent = () =>
    test(() => {
      const typedSecret = fields.some((f) => f.secret && (values[f.key] ?? '').trim() !== '');
      return typedSecret
        ? api.testConnectionMaterial({
            connectorId: connection.connectorId,
            authScheme: connection.authScheme,
            baseUrl: connection.baseUrl,
            material: nonEmpty(),
          })
        : api.testConnection(connection.connectionId);
    });

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // Only the fields the user actually changed (merged server-side): a typed
      // secret, or a non-secret whose value differs from what was loaded.
      const material: Record<string, string> = {};
      for (const f of fields) {
        const val = values[f.key] ?? '';
        if (f.secret) {
          if (val.trim() !== '') material[f.key] = val;
        } else if (val !== (original[f.key] ?? '')) {
          material[f.key] = val;
        }
      }
      const changes: { name?: string; material?: Record<string, string> } = {};
      const trimmed = name.trim();
      if (trimmed && trimmed !== connection.name) changes.name = trimmed;
      if (Object.keys(material).length > 0) changes.material = material;
      if (Object.keys(changes).length === 0) {
        onCancel();
        return;
      }
      await api.updateConnection(connection.connectionId, changes);
      onSaved();
    } catch {
      setError('could not save the connection');
      setBusy(false);
    }
  };

  return (
    <div className="conn-form">
      <div className="conn-form-body">
        <div className="field">
          <label htmlFor="edit-name">Connection name</label>
          <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        {fields.length > 0 && <p className="help">Leave a credential blank to keep the current value.</p>}
        <CredentialInputs fields={fields} values={values} onChange={set} idPrefix="edit" keepBlankPlaceholder />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="conn-form-foot">
        <TestRow health={health} onTest={() => void testCurrent()} label="Test" />
        <div className="conn-form-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
