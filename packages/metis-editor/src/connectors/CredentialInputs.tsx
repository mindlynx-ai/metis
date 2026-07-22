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
import { type CredentialFieldDef } from '../api.js';

/** A set of credential inputs bound to a values bag (placeholder/help/required). */
export function CredentialInputs({
  fields,
  values,
  onChange,
  idPrefix,
  keepBlankPlaceholder,
}: {
  fields: CredentialFieldDef[];
  values: Record<string, string>;
  onChange(key: string, value: string): void;
  idPrefix: string;
  /** In edit mode a blank field keeps the current secret. */
  keepBlankPlaceholder?: boolean;
}) {
  if (fields.length === 0) return <p className="help">This connector needs no credentials.</p>;
  return (
    <>
      {fields.map((field) => (
        <div className="field" key={field.key}>
          <label htmlFor={`${idPrefix}-${field.key}`}>
            {field.label}
            {!field.required && <span className="field-opt"> · optional</span>}
          </label>
          <input
            id={`${idPrefix}-${field.key}`}
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={keepBlankPlaceholder && field.secret ? 'Unchanged' : field.placeholder}
            value={values[field.key] ?? ''}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
          {field.help && <p className="field-help">{field.help}</p>}
        </div>
      ))}
    </>
  );
}
