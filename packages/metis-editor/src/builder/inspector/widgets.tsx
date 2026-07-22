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
 * Rich config widgets. Unlike the plain draft-string controls, these own a
 * structured value and commit it directly to the store: method pills, a
 * headers key/value/enabled editor (emitting the array format the HTTP node
 * prefers), and a body-type editor (the {type, content} envelope the node
 * unwraps). Each is controlled by the config value it is given, so an edit
 * flows straight through the flow store and back.
 */
import { useState } from 'react';
import type { JsonSchemaProperty } from '../../api.js';

interface RichProps {
  id: string;
  value: unknown;
  property: JsonSchemaProperty;
  describedBy?: string;
  onCommit(value: unknown): void;
}

/** Primary methods get their own pills; the rest hide in an overflow select. */
const PRIMARY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function MethodPills({ id, value, property, describedBy, onCommit }: RichProps) {
  const options = (property.enum ?? PRIMARY_METHODS).map(String);
  const current = typeof value === 'string' ? value : '';
  const primary = options.filter((option) => PRIMARY_METHODS.includes(option));
  const overflow = options.filter((option) => !PRIMARY_METHODS.includes(option));
  return (
    <div className="method-pills" role="group" aria-labelledby={id} aria-describedby={describedBy}>
      {primary.map((option) => (
        <button
          key={option}
          type="button"
          className={`pill${current === option ? ' active' : ''}`}
          aria-pressed={current === option}
          onClick={() => onCommit(option)}
        >
          {option}
        </button>
      ))}
      {overflow.length > 0 && (
        <select
          className="pill-overflow"
          aria-label="More methods"
          value={overflow.includes(current) ? current : ''}
          onChange={(event) => event.target.value && onCommit(event.target.value)}
        >
          <option value="">More</option>
          {overflow.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

interface HeaderRow {
  key: string;
  value: string;
  enabled: boolean;
}

/** Read any stored header shape (array rows or legacy record) into rows. */
function toRows(value: unknown): HeaderRow[] {
  if (Array.isArray(value)) {
    return value.map((row) => {
      const record = (row ?? {}) as Partial<HeaderRow>;
      return { key: record.key ?? '', value: record.value ?? '', enabled: record.enabled !== false };
    });
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, val]) => ({
      key,
      value: String(val ?? ''),
      enabled: true,
    }));
  }
  return [];
}

const BLANK_ROW: HeaderRow = { key: '', value: '', enabled: true };

export function HeadersEditor({ id, value, describedBy, onCommit }: RichProps) {
  // Local rows so a freshly-added blank row survives (the store drops blanks).
  // Remounted per node via a key on the field, so this seeds from that node.
  const [rows, setRows] = useState<HeaderRow[]>(() => {
    const initial = toRows(value);
    return initial.length > 0 ? initial : [BLANK_ROW];
  });
  const commit = (next: HeaderRow[]) => {
    setRows(next);
    // Drop fully-blank rows so the stored value stays clean.
    const cleaned = next.filter((row) => row.key !== '' || row.value !== '');
    onCommit(cleaned.length > 0 ? cleaned : undefined);
  };
  const update = (index: number, patch: Partial<HeaderRow>) => {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  // Add is local only: a blank row commits nothing until the user types.
  const add = () => setRows((current) => [...current, { ...BLANK_ROW }]);
  const remove = (index: number) => commit(rows.filter((_row, i) => i !== index));

  return (
    <div className="kv-editor" aria-describedby={describedBy}>
      {rows.map((row, index) => (
        <div className="kv-row" key={index}>
          <label className="switch kv-toggle">
            <input
              type="checkbox"
              checked={row.enabled}
              aria-label={`Enable header ${row.key || index + 1}`}
              onChange={(event) => update(index, { enabled: event.target.checked })}
            />
            <span className="switch-track" aria-hidden="true" />
          </label>
          <input
            className="kv-key"
            placeholder="Name"
            aria-label={`Header ${index + 1} name`}
            value={row.key}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <input
            className="kv-val"
            placeholder="Value"
            aria-label={`Header ${index + 1} value`}
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="kv-remove"
            aria-label={`Remove header ${index + 1}`}
            onClick={() => remove(index)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm kv-add" id={id} onClick={add}>
        Add header
      </button>
    </div>
  );
}

interface BodyValue {
  type: string;
  content: unknown;
}

const BODY_LABELS: Record<string, string> = {
  none: 'None',
  json: 'JSON',
  form: 'Form',
  text: 'Text',
};

/** Body content as the textarea's string: JSON is pretty-printed, else raw. */
function bodyContentToText(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

export function BodyEditor({ id, value, property, describedBy, onCommit }: RichProps) {
  const types = (property.properties?.type?.enum ?? ['none', 'json', 'form', 'text']).map(String);
  const body = (value ?? {}) as Partial<BodyValue>;
  const type = typeof body.type === 'string' ? body.type : 'none';
  // Seeded once at mount; the field is remounted per node (keyed) so this
  // reseeds on selection without clobbering the caret mid-edit.
  const [draft, setDraft] = useState(() => bodyContentToText(body.content));
  const [error, setError] = useState<string>();

  // Commit the draft interpreted under a given type (JSON parses, else raw).
  const commitAs = (kind: string, raw: string) => {
    if (kind === 'none') {
      onCommit(undefined);
      setError(undefined);
      return;
    }
    if (kind === 'json') {
      if (raw.trim() === '') {
        onCommit({ type: kind, content: undefined });
        setError(undefined);
        return;
      }
      try {
        onCommit({ type: kind, content: JSON.parse(raw) });
        setError(undefined);
      } catch {
        setError('must be valid JSON');
      }
      return;
    }
    onCommit({ type: kind, content: raw === '' ? undefined : raw });
    setError(undefined);
  };

  const setContent = (raw: string) => {
    setDraft(raw);
    commitAs(type, raw);
  };

  return (
    <div className="body-editor" aria-describedby={describedBy}>
      <div className="seg" role="group" aria-label="Body type" id={id}>
        {types.map((option) => (
          <button
            key={option}
            type="button"
            className={`seg-btn${type === option ? ' active' : ''}`}
            aria-pressed={type === option}
            onClick={() => commitAs(option, draft)}
          >
            {BODY_LABELS[option] ?? option}
          </button>
        ))}
      </div>
      {type !== 'none' && (
        <>
          <textarea
            className="mono body-content"
            aria-label="Body content"
            aria-invalid={Boolean(error) || undefined}
            rows={6}
            value={draft}
            onChange={(event) => setContent(event.target.value)}
          />
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
