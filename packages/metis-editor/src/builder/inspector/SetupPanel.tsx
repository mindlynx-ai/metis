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
 * The Setup tab body, top to bottom as progressive disclosure: "What it
 * receives" (upstream data), the configuration form, then "Passes on"
 * (this step's outputs). Essential fields lead; the rest sit behind "Show
 * advanced". Simple fields edit as draft strings; rich fields (method,
 * headers, body) own a structured value and merge live into the store.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogueEntry, JsonSchema, JsonSchemaProperty, WorkflowNode } from '../../api.js';
import { useFlow } from '../../flow-store.js';
import { toast } from '../../toast-store.js';
import { fromDraftValue, RICH_WIDGETS, toDraftValue, widgetFor, type Widget } from './schema.js';
import { BodyEditor, HeadersEditor, MethodPills } from './widgets.js';
import { OutputsPanel } from './io-panels.js';
import { ConnectorPicker } from './ConnectorPicker.js';
import { OperationParams } from './OperationParams.js';
import { DataBuilder } from './DataBuilder.js';
import { SwitchBuilder } from './SwitchBuilder.js';
import { LogicBuilder } from './LogicBuilder.js';
import { FilterBuilder } from './FilterBuilder.js';
import { parseConnectorScope } from './connector-scope.js';
import { SampleRequest, isSampleable } from './SampleRequest.js';
import { VariablePalette } from './VariablePalette.js';
import { collectUpstreamVariables } from './upstream-variables.js';
import { insertAtCursor, isReferenceTarget } from './insert-reference.js';

type Draft = Record<string, string>;

// The connection picker owns only the connectorRef field (the chosen
// connection id); every other field renders through the generic form.
const MANAGED_BY_CONNECTOR = new Set(['connectorId']);

/** The draft-string control for a simple widget. Native inputs where they fit. */
function SimpleControl({
  id,
  widget,
  property,
  draft,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  widget: Widget;
  property: JsonSchemaProperty;
  draft: string;
  invalid: boolean;
  describedBy?: string;
  onChange(next: string): void;
}) {
  const common = { id, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy };
  const set = (event: { target: { value: string } }) => onChange(event.target.value);

  if (widget === 'select') {
    return (
      <select {...common} value={draft} onChange={set}>
        <option value="">Choose</option>
        {(property.enum ?? []).map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  }
  if (widget === 'checkbox') {
    return (
      <label className="switch">
        <input
          {...common}
          type="checkbox"
          checked={draft === 'true'}
          onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
        />
        <span className="switch-track" aria-hidden="true" />
      </label>
    );
  }
  if (widget === 'number') {
    return (
      <input {...common} type="number" value={draft} min={property.minimum} max={property.maximum} onChange={set} />
    );
  }
  if (widget === 'uri') {
    return <input {...common} type="url" inputMode="url" value={draft} onChange={set} placeholder="https://" />;
  }
  if (widget === 'date') {
    return (
      <input
        {...common}
        type={property.format === 'date-time' ? 'datetime-local' : 'date'}
        value={draft}
        onChange={set}
      />
    );
  }
  if (widget === 'textarea' || widget === 'json') {
    return <textarea {...common} className="mono" rows={widget === 'textarea' ? 6 : 4} value={draft} onChange={set} />;
  }
  return <input {...common} value={draft} onChange={set} />;
}

/** A labelled field wrapping either a simple draft control or a rich widget. */
function Field({
  node,
  name,
  property,
  draft,
  error,
  onDraft,
}: {
  node: WorkflowNode;
  name: string;
  property: JsonSchemaProperty;
  draft: string;
  error?: string;
  onDraft(next: string): void;
}) {
  const flow = useFlow();
  const widget = widgetFor(name, property);
  const id = `field-${name}`;
  const label = property.title ?? name;
  const help = property.description;
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(' ') || undefined;
  const isRich = RICH_WIDGETS.has(widget);
  const commit = (value: unknown) => flow.updateConfigField(node.id, name, value);
  const value = node.data?.config?.[name];

  return (
    <div className="field" data-field={name}>
      {/* Rich groups own their labelling via aria-labelledby to this id. */}
      <label htmlFor={isRich ? undefined : id} id={isRich ? id : undefined}>
        {label}
      </label>
      {widget === 'method' && (
        <MethodPills id={id} value={value} property={property} describedBy={describedBy} onCommit={commit} />
      )}
      {widget === 'headers' && (
        <HeadersEditor id={id} value={value} property={property} describedBy={describedBy} onCommit={commit} />
      )}
      {widget === 'body' && (
        <BodyEditor id={id} value={value} property={property} describedBy={describedBy} onCommit={commit} />
      )}
      {!isRich && (
        <SimpleControl
          id={id}
          widget={widget}
          property={property}
          draft={draft}
          invalid={Boolean(error)}
          describedBy={describedBy}
          onChange={onDraft}
        />
      )}
      {help && (
        <div className="help" id={helpId}>
          {help}
        </div>
      )}
      {error && (
        <div className="field-error" id={errId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function SetupPanel({
  node,
  entry,
  catalogue,
}: {
  node: WorkflowNode;
  entry: CatalogueEntry | undefined;
  catalogue: CatalogueEntry[];
}) {
  const flow = useFlow();
  const schema = (entry?.configSchema ?? {}) as JsonSchema;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const names = Object.keys(properties);
  const connectorField = names.find((name) => widgetFor(name, properties[name]!) === 'connector');
  const hasConnector = Boolean(connectorField);
  // The field's x-helix-options (e.g. ?provider=sendgrid) scopes the picker so a
  // typed step cannot pick an unrelated connector.
  const connectorScope = connectorField
    ? parseConnectorScope(properties[connectorField]?.['x-helix-options'])
    : {};
  // The operation params + data-builder fields render through their own widgets
  // (operation/connection-aware), so the generic form hides them.
  const operationParamsField = names.find(
    (name) => widgetFor(name, properties[name]!) === 'operationParams',
  );
  const dataBuilderField = names.find(
    (name) => widgetFor(name, properties[name]!) === 'dataBuilder',
  );
  const switchBuilderField = names.find(
    (name) => widgetFor(name, properties[name]!) === 'switchBuilder',
  );
  const logicBuilderField = names.find(
    (name) => widgetFor(name, properties[name]!) === 'logicBuilder',
  );
  const filterBuilderField = names.find(
    (name) => widgetFor(name, properties[name]!) === 'filterBuilder',
  );
  const shown = (name: string) =>
    name !== operationParamsField &&
    name !== dataBuilderField &&
    name !== switchBuilderField &&
    name !== logicBuilderField &&
    name !== filterBuilderField &&
    (!hasConnector || !MANAGED_BY_CONNECTOR.has(name));
  const requiredNames = names.filter((name) => required.has(name) && shown(name));
  const optionalNames = names.filter((name) => !required.has(name) && shown(name));

  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Seed simple-field drafts from the stored config (defaults included).
  // Rich fields read the store directly, so they need no draft.
  useEffect(() => {
    const next: Draft = {};
    for (const [name, property] of Object.entries(properties)) {
      const widget = widgetFor(name, property);
      if (RICH_WIDGETS.has(widget)) continue;
      const stored = node.data?.config?.[name];
      next[name] = toDraftValue(stored === undefined ? property.default : stored, widget);
    }
    setDraft(next);
    setErrors({});
    // Reseeds on selection or node-type change only.
  }, [node.id, entry?.type]);

  const onDraft = (name: string, property: JsonSchemaProperty) => (raw: string) => {
    setDraft((current) => ({ ...current, [name]: raw }));
    const { value, error } = fromDraftValue(raw, widgetFor(name, property));
    if (error) {
      setErrors((current) => ({ ...current, [name]: error }));
      return;
    }
    setErrors((current) => {
      if (!current[name]) return current;
      const rest = { ...current };
      delete rest[name];
      return rest;
    });
    flow.updateConfigField(node.id, name, value);
  };

  const renderField = (name: string) => {
    const property = properties[name];
    if (!property) return null;
    return (
      <Field
        key={`${node.id}-${name}`}
        node={node}
        name={name}
        property={property}
        draft={draft[name] ?? ''}
        error={errors[name]}
        onDraft={onDraft(name, property)}
      />
    );
  };

  const hasUpstream = flow.edges.some((edge) => edge.target === node.id);
  const upstream = useMemo(
    () => collectUpstreamVariables({ nodeId: node.id, nodes: flow.nodes, edges: flow.edges, catalogue }),
    [node.id, flow.nodes, flow.edges, catalogue],
  );

  // Remember the last reference-meaningful field focused inside this panel, so a
  // chip click (which itself never steals focus) inserts into what you were
  // editing. document.activeElement alone is unreliable once the chip is pressed.
  const panelRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return undefined;
    const onFocusIn = (event: FocusEvent) => {
      if (isReferenceTarget(event.target as Element)) {
        targetRef.current = event.target as HTMLInputElement | HTMLTextAreaElement;
      }
    };
    el.addEventListener('focusin', onFocusIn);
    return () => el.removeEventListener('focusin', onFocusIn);
  }, []);
  // A new node's fields are different DOM; drop the stale target on select.
  useEffect(() => {
    targetRef.current = null;
  }, [node.id]);

  const insertReference = (reference: string) => {
    const target = targetRef.current;
    if (target && target.isConnected && panelRef.current?.contains(target)) {
      insertAtCursor(target, reference);
    } else {
      navigator.clipboard?.writeText(reference)?.catch(() => undefined);
      toast.info('Reference copied - focus a field to insert it directly');
    }
  };

  return (
    <div className="setup-panel" ref={panelRef}>
      <details className="io-region" open={hasUpstream}>
        <summary>
          <span>What it receives</span>
        </summary>
        <div className="io-region-body">
          <VariablePalette sources={upstream} onInsert={insertReference} />
        </div>
      </details>

      {names.length === 0 ? (
        <p className="ins-placeholder">This step needs no settings.</p>
      ) : (
        <section className="ins-region" aria-label="Configure">
          {hasConnector && <ConnectorPicker node={node} scope={connectorScope} />}
          {dataBuilderField && <DataBuilder node={node} />}
          {switchBuilderField && <SwitchBuilder node={node} />}
          {logicBuilderField && <LogicBuilder node={node} />}
          {filterBuilderField && <FilterBuilder node={node} />}
          {requiredNames.map(renderField)}
          {operationParamsField && (
            <OperationParams node={node} connectorType={entry?.type ?? ''} />
          )}
          {/* Progressive disclosure only makes sense when something is primary:
              a schema with no required fields renders everything up front
              instead of hiding its whole form behind "Show advanced". */}
          {requiredNames.length === 0 && optionalNames.map(renderField)}
          {requiredNames.length > 0 && optionalNames.length > 0 && (
            <details className="disclosure">
              <summary>
                <span>Show advanced</span>
                <span className="disclosure-count">{optionalNames.length}</span>
              </summary>
              <div className="disclosure-body">{optionalNames.map(renderField)}</div>
            </details>
          )}
        </section>
      )}

      <details className="io-region" open={isSampleable(node.type)}>
        <summary>
          <span>Passes on</span>
        </summary>
        <div className="io-region-body">
          {isSampleable(node.type) && <SampleRequest node={node} />}
          <OutputsPanel node={node} entry={entry} />
        </div>
      </details>

      <details className="io-region">
        <summary>
          <span>Details</span>
        </summary>
        <div className="io-region-body">
          <DetailsSection node={node} />
        </div>
      </details>
    </div>
  );
}

/** Free-form notes and tags for the step, persisted with the workflow. */
function DetailsSection({ node }: { node: WorkflowNode }) {
  const flow = useFlow();
  const tags = Array.isArray(node.data?.metadata?.tags) ? (node.data.metadata.tags as string[]) : [];
  return (
    <div className="ins-region">
      <div className="field">
        <label htmlFor="details-notes">Notes</label>
        <textarea
          id="details-notes"
          rows={3}
          value={node.data?.description ?? ''}
          placeholder="What this step is for"
          onChange={(event) => flow.updateDescription(node.id, event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="details-tags">Tags</label>
        <input
          id="details-tags"
          value={tags.join(', ')}
          placeholder="comma, separated"
          onChange={(event) =>
            flow.updateMetadata(node.id, {
              tags: event.target.value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
    </div>
  );
}
