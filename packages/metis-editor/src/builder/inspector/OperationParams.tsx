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
 * The operation parameters widget - the "what you receive" half of a connector
 * node. Once an operation is chosen it renders one labelled, typed field per
 * declared parameter (e.g. an email node shows From / To / Subject / Body) plus
 * any path placeholder from the template, and keeps a freeform key/value editor
 * for extra query or body values the operation does not declare. Everything is
 * owned in local state and committed together into the node's `params` object.
 */
import { useEffect, useState } from 'react';
import { type ConnectorDef, type WorkflowNode, type OperationParameter } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import { loadConnectors } from './connectors-cache.js';

const placeholdersOf = (pathTemplate: string): string[] =>
  [...pathTemplate.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '');

interface Field {
  key: string;
  value: string;
  /** 'declared' + 'placeholder' fields have a fixed key; 'extra' keys are editable. */
  kind: 'declared' | 'placeholder' | 'extra';
  label?: string;
  type?: OperationParameter['type'];
  required?: boolean;
  placeholder?: string;
  description?: string;
}

export function OperationParams({
  node,
  connectorType,
}: {
  node: WorkflowNode;
  connectorType: string;
}) {
  const flow = useFlow();
  const [connectors, setConnectors] = useState<ConnectorDef[]>([]);
  const [fields, setFields] = useState<Field[]>([]);

  useEffect(() => {
    let live = true;
    loadConnectors().then((list) => live && setConnectors(list));
    return () => {
      live = false;
    };
  }, []);

  const config = node.data?.config ?? {};
  const operationName = String(config.operation ?? '');
  const connector = connectors.find((c) => c.connectorId === connectorType);
  const operation = connector?.operations?.find((o) => o.name === operationName);
  const template = operation?.pathTemplate ?? '';
  const declared = operation?.parameters ?? [];
  // A stable signature so the seed effect reruns when the declared set changes
  // (it resolves once the catalogue loads).
  const declaredKey = declared.map((p) => p.key).join(',');

  // Mirror the operation's declared outputs onto the node instance (the "what
  // you give" half): the outputs panel and the downstream variable picker both
  // read data.outputs. Connector nodes have no sample-capture, so this seeding
  // owns data.outputs outright; it reseeds when the operation changes and is
  // guarded so opening a node never marks it dirty.
  const outputsKey = (operation?.outputs ?? []).map((o) => o.key).join(',');
  useEffect(() => {
    const current = node.data?.outputs as { manualData?: { key?: string }[] }[] | undefined;
    const currentKey = (current?.[0]?.manualData ?? []).map((row) => row.key).join(',');
    if (currentKey === outputsKey) return;
    const outputs = operation?.outputs ?? [];
    flow.updateOutputs(
      node.id,
      outputs.length > 0
        ? [{ manualData: outputs.map((o) => ({ key: o.key, type: o.type ?? 'string', value: '' })) }]
        : [],
    );
  }, [node.id, operationName, outputsKey]);

  // Seed/reseed the fields when the node, the operation, or the resolved
  // parameter/template set changes.
  useEffect(() => {
    const stored = (node.data?.config?.params ?? {}) as Record<string, unknown>;
    const declaredKeys = new Set(declared.map((p) => p.key));
    const seeded: Field[] = declared.map((p) => ({
      key: p.key,
      value: String(stored[p.key] ?? ''),
      kind: 'declared',
      label: p.label,
      type: p.type,
      required: p.required,
      placeholder: p.placeholder,
      description: p.description,
    }));
    // Path placeholders the operation did not declare (labelled by their token).
    for (const key of placeholdersOf(template)) {
      if (!declaredKeys.has(key)) {
        seeded.push({ key, value: String(stored[key] ?? ''), kind: 'placeholder' });
        declaredKeys.add(key);
      }
    }
    // Anything else already stored is a freeform extra.
    for (const [key, value] of Object.entries(stored)) {
      if (!declaredKeys.has(key)) seeded.push({ key, value: String(value ?? ''), kind: 'extra' });
    }
    setFields(seeded);
  }, [node.id, operationName, template, declaredKey]);

  const commit = (next: Field[]) => {
    setFields(next);
    const params: Record<string, string> = {};
    for (const field of next) {
      if (field.key.trim() !== '') params[field.key.trim()] = field.value;
    }
    flow.updateConfigField(node.id, 'params', Object.keys(params).length > 0 ? params : undefined);
  };

  const updateField = (index: number, patch: Partial<Field>) =>
    commit(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  const removeField = (index: number) => commit(fields.filter((_, i) => i !== index));
  const addExtra = () => commit([...fields, { key: '', value: '', kind: 'extra' }]);

  if (!operationName) {
    return <p className="help">Choose an operation to set its parameters.</p>;
  }

  const extras = fields.map((field, index) => ({ field, index })).filter((f) => f.field.kind === 'extra');
  const fixed = fields.map((field, index) => ({ field, index })).filter((f) => f.field.kind !== 'extra');

  return (
    <div className="op-params">
      {operation?.description && (
        <p className="help">
          {operation.method} {template}
          {operation.description ? `: ${operation.description}` : ''}
        </p>
      )}

      {fixed.map(({ field, index }) => {
        const id = `op-param-${field.key}`;
        return (
          <div className="field" data-field={`param-${field.key}`} key={`p-${field.key}`}>
            <label htmlFor={id}>
              {field.label ?? field.key}
              {field.required && <span className="req" aria-hidden="true"> *</span>}
            </label>
            {field.type === 'text' ? (
              <textarea
                id={id}
                rows={4}
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => updateField(index, { value: event.target.value })}
              />
            ) : (
              <input
                id={id}
                type={field.type === 'number' ? 'number' : 'text'}
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => updateField(index, { value: event.target.value })}
              />
            )}
            {field.description && <p className="field-help">{field.description}</p>}
          </div>
        );
      })}

      <div className="op-extra">
        <span className="op-extra-label">
          {fixed.length > 0 ? 'More parameters (query or body)' : 'Parameters (query or body)'}
        </span>
        <div className="kv-editor">
          {extras.map(({ field, index }) => (
            <div className="kv-row" key={`e-${index}`}>
              <input
                className="kv-key"
                value={field.key}
                placeholder="key"
                onChange={(event) => updateField(index, { key: event.target.value })}
              />
              <input
                className="kv-val"
                value={field.value}
                placeholder="value"
                onChange={(event) => updateField(index, { value: event.target.value })}
              />
              <button
                type="button"
                className="btn btn-sm kv-remove"
                aria-label={`Remove ${field.key || 'parameter'}`}
                onClick={() => removeField(index)}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={addExtra}>
            Add parameter
          </button>
        </div>
      </div>
    </div>
  );
}
