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
 * The node inspector: a premium right-side panel (never a modal) built on
 * progressive disclosure. A category-tinted header with an editable step
 * name, a keyboard `tablist` (Setup / Test / History / Policy), and a
 * footer that Saves. Edits merge live into the flow store so "we save it,
 * come back, and it is the same" holds literally. Setup is built here;
 * Test / History / Policy panels arrive in later phases.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogueEntry } from '../api.js';
import { toast } from '../toast-store.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { Icon } from '../ui/Icon.js';
import { useFlow } from '../flow-store.js';
import { SetupPanel } from './inspector/SetupPanel.js';
import { TestTab } from './inspector/TestTab.js';
import { HistoryTab } from './inspector/HistoryTab.js';
import { PolicyTab } from './inspector/PolicyTab.js';
import { GuidePanel } from './inspector/GuidePanel.js';
import { entryFor } from './inspector/upstream-variables.js';

const TABS = [
  { id: 'setup', label: 'Setup' },
  { id: 'guide', label: 'Guide' },
  { id: 'test', label: 'Test' },
  { id: 'history', label: 'History' },
  { id: 'policy', label: 'Policy' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const SAVE_LABELS: Record<'idle' | 'saving' | 'saved' | 'error', string> = {
  idle: 'Save',
  saving: 'Saving',
  saved: 'Saved',
  error: 'Save',
};

export function Inspector({
  catalogue,
  onSave,
}: {
  catalogue: CatalogueEntry[];
  // The page's save: persists and, on first create, moves to the new id's
  // URL so a reload restores exactly this workflow. Falls back to a bare
  // store save when the inspector is used outside the page.
  onSave?: () => Promise<string | undefined>;
}) {
  const flow = useFlow();
  const node = flow.nodes.find((candidate) => candidate.id === flow.selectedNodeId);
  const entry = useMemo(() => (node ? entryFor(catalogue, node) : undefined), [catalogue, node]);

  const [tab, setTab] = useState<TabId>('setup');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const tablistRef = useRef<HTMLDivElement>(null);

  // Reset to Setup and clear any save flash whenever the selection changes.
  useEffect(() => {
    setTab('setup');
    setSaveState('idle');
  }, [flow.selectedNodeId]);

  if (!node) return null;

  const category = entry?.category ?? 'integration';
  const description = entry?.palette?.description ?? '';
  const glyph = (entry?.palette?.label ?? node.type).slice(0, 2).toUpperCase();

  const save = async () => {
    setSaveState('saving');
    try {
      await (onSave ? onSave() : flow.save());
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  };

  // The Guide tab only exists when the node's catalogue entry carries docs.
  const tabs = entry?.docs ? TABS : TABS.filter((candidate) => candidate.id !== 'guide');
  const activeTab = tab === 'guide' && !entry?.docs ? 'setup' : tab;

  // Roving-tabindex keyboard support for the tablist (WAI-ARIA pattern).
  const onTabKey = (event: React.KeyboardEvent) => {
    const index = tabs.findIndex((candidate) => candidate.id === activeTab);
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    if (target) {
      setTab(target.id);
      const button = tablistRef.current?.querySelector<HTMLButtonElement>(`#tab-${target.id}`);
      button?.focus();
    }
  };

  // The inspector is always the wide panel (the user/developer mode was removed).
  const wide = ' inspector-wide';

  return (
    <aside className={`inspector cat-${category}${wide}`} aria-label="Step settings">
      <header className="ins-head">
        <div className="ins-head-row">
          <span className="ins-icon" aria-hidden="true">
            {glyph}
          </span>
          <span className="ins-type">
            {node.type} <span className="mono">{node.id.slice(0, 8)}</span>
          </span>
          <button
            type="button"
            className="ins-close"
            aria-label="Close settings"
            onClick={() => flow.select(undefined)}
          >
            <Icon name="x" />
          </button>
        </div>
        <input
          className="ins-title"
          value={node.data?.label ?? ''}
          aria-label="Step name"
          onChange={(event) => flow.updateLabel(node.id, event.target.value)}
        />
        {description && <p className="ins-desc">{description}</p>}
      </header>

      <div
        className="ins-tabs"
        role="tablist"
        aria-label="Step sections"
        ref={tablistRef}
        onKeyDown={onTabKey}
      >
        {tabs.map((candidate) => {
          const selected = candidate.id === activeTab;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              id={`tab-${candidate.id}`}
              aria-selected={selected}
              aria-controls={`panel-${candidate.id}`}
              tabIndex={selected ? 0 : -1}
              className={`ins-tab${selected ? ' active' : ''}`}
              onClick={() => setTab(candidate.id)}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>

      <div
        className="ins-body"
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'setup' && <SetupPanel node={node} entry={entry} catalogue={catalogue} />}
        {activeTab === 'guide' && entry?.docs && <GuidePanel markdown={entry.docs} />}
        {activeTab === 'test' && <TestTab node={node} onSave={onSave} />}
        {activeTab === 'history' && <HistoryTab node={node} />}
        {activeTab === 'policy' && <PolicyTab node={node} entry={entry} />}
      </div>

      <footer className="ins-foot">
        <button
          type="button"
          className="btn btn-ghost ins-remove"
          onClick={() => setConfirmRemove(true)}
        >
          <Icon name="trash" size={14} /> Remove step
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={saveState === 'saving'}
        >
          {SAVE_LABELS[saveState]}
        </button>
      </footer>
      {saveState === 'error' && (
        <p className="ins-save-error" role="alert">
          Could not save. Try again.
        </p>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove "${node.data?.label ?? node.type}"?`}
          body="The step and its connections are removed from the canvas. This is saved on your next Save."
          onConfirm={() => {
            setConfirmRemove(false);
            flow.removeNode(node.id);
            toast.info('Step removed');
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </aside>
  );
}
