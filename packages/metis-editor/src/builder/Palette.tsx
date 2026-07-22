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
 * The node library: a floating glass panel opened from "Add step".
 * Open categories come live from the catalogue. Cloud capabilities render
 * as locked cards from the offers manifest (LOCKED_TIERS below is the
 * offline fallback) - storefront metadata only, no paid code exists to
 * import (the module-boundary gate holds that true). A 'both' entry gets
 * the lite-with-uplift treatment: the local card plus a quiet cloud reveal.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useReactFlow } from '@xyflow/react';
import type { CatalogueEntry } from '../api.js';
import { useFlow } from '../flow-store.js';
import { ensureUplift, useUplift } from '../uplift-store.js';
import { Icon } from '../ui/Icon.js';
import { defaultsFor } from './inspector/schema.js';
import { nodeIcon } from './node-visual.js';
import { suggestedStepTypes, suggestedTitle } from './suggested-steps.js';

/** Storefront metadata only: names and pitches, never implementations. */
export const LOCKED_TIERS: { name: string; pitch: string }[] = [
  { name: 'Big data', pitch: 'Query millions of rows (Athena, Snowflake).' },
  { name: 'Memory', pitch: 'Give workflows long-term recall with Cortex.' },
  { name: 'Agents', pitch: 'Delegate steps to autonomous skills.' },
  { name: 'Approvals', pitch: 'Human sign-off gates inside a run.' },
];

// The picker groups: core building blocks first (always open), then the app
// categories (collapsed, so the list stays scannable as connectors grow to
// thousands). Order and titles live here; the group key comes from the entry.
const GROUP_ORDER = [
  'trigger',
  'logic',
  'transform',
  'developer-tools',
  'communication',
  'artificial-intelligence',
  'ai-agent-tool',
  'data-flow',
  'productivity',
  'marketing',
  'sales-and-crm',
  'commerce',
  'customer-support',
  'content-and-files',
  'forms-and-surveys',
  'accounting',
  'business-intelligence',
  'api',
  'other',
];
const GROUP_TITLES: Record<string, string> = {
  trigger: 'Triggers',
  logic: 'Logic',
  transform: 'Transform',
  'developer-tools': 'Developer tools',
  communication: 'Communication',
  'artificial-intelligence': 'AI',
  'ai-agent-tool': 'AI agents',
  'data-flow': 'Data & flow',
  productivity: 'Productivity',
  marketing: 'Marketing',
  'sales-and-crm': 'Sales & CRM',
  commerce: 'Commerce',
  'customer-support': 'Support',
  'content-and-files': 'Content & files',
  'forms-and-surveys': 'Forms',
  accounting: 'Accounting',
  'business-intelligence': 'Analytics',
  api: 'API',
  other: 'Other',
};
// The core building blocks stay expanded; app categories collapse by default.
const OPEN_GROUPS = new Set(['trigger', 'logic', 'transform', 'developer-tools']);
const CORE_CATEGORIES = new Set(['trigger', 'logic', 'transform']);

/** The picker group an entry belongs to: its core category, else its app group. */
function groupKeyOf(entry: CatalogueEntry): string {
  if (CORE_CATEGORIES.has(entry.category)) return entry.category;
  return entry.group ?? 'other';
}

/** Relevance of an entry to a search query (0 = no match); higher ranks first. */
function scoreEntry(entry: CatalogueEntry, query: string): number {
  const q = query.toLowerCase().trim();
  if (q === '') return 0;
  const label = String(entry.palette?.label ?? entry.type).toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 85;
  if (label.includes(q)) return 65;
  const keywords = entry.keywords ?? [];
  if (keywords.includes(q)) return 55;
  if (keywords.some((keyword) => keyword.includes(q))) return 40;
  if (String(entry.group ?? '').replace(/-/g, ' ').includes(q)) return 30;
  if (String(entry.palette?.description ?? '').toLowerCase().includes(q)) return 15;
  if (entry.type.toLowerCase().includes(q)) return 10;
  return 0;
}

export function Palette({
  catalogue,
  open,
  onClose,
  fromNodeId,
}: {
  catalogue: CatalogueEntry[];
  open: boolean;
  onClose: () => void;
  fromNodeId?: string;
}) {
  const flow = useFlow();
  const { screenToFlowPosition, setCenter, getZoom } = useReactFlow();
  const [query, setQuery] = useState('');
  // The cloud standing drives the uplift affordances; 'disabled' (the kill
  // switch) renders the palette exactly as the open build always has.
  const uplift = useUplift();
  useEffect(ensureUplift, []);
  const cloudOn = uplift.cloud !== 'disabled';

  // Start each open with a clean search (a prior open may have left a query).
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  // Escape closes the library, like the reference builder.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const ready = useMemo(
    () => catalogue.filter((entry) => !entry.alias_of && entry.handler_status === 'ready'),
    [catalogue],
  );

  const searching = query.trim() !== '';

  // Search: a flat, relevance-ranked list across every group.
  const ranked = useMemo(() => {
    if (!searching) return [];
    return ready
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.type.localeCompare(b.entry.type))
      .map((hit) => hit.entry);
  }, [ready, query, searching]);

  // Featured "suggested" steps: nudge an empty canvas to a trigger, else follow
  // from the step this one is being added after.
  const hasNodes = flow.nodes.length > 0;
  const fromCategory = useMemo(() => {
    const fromNode = fromNodeId ? flow.nodes.find((node) => node.id === fromNodeId) : undefined;
    return fromNode ? catalogue.find((entry) => entry.type === fromNode.type)?.category : undefined;
  }, [fromNodeId, flow.nodes, catalogue]);
  const suggested = useMemo(() => {
    const byType = new Map(ready.map((entry) => [entry.type, entry]));
    return suggestedStepTypes(fromCategory, hasNodes)
      .map((type) => byType.get(type))
      .filter((entry): entry is CatalogueEntry => Boolean(entry));
  }, [ready, fromCategory, hasNodes]);

  // Cloud-only capabilities (no local node carries their entitlement) become
  // the locked cards, overlaying the static LOCKED_TIERS offline fallback.
  const lockedOffers = useMemo(() => {
    const inline = new Set(
      ready
        .filter((entry) => entry.execution === 'both' && entry.entitlement)
        .map((entry) => entry.entitlement),
    );
    return uplift.offers.filter((offer) => !inline.has(offer.id));
  }, [ready, uplift.offers]);

  // Browse: entries bucketed into groups, in the fixed group order.
  const groups = useMemo(() => {
    const byGroup = new Map<string, CatalogueEntry[]>();
    for (const entry of ready) {
      const key = groupKeyOf(entry);
      (byGroup.get(key) ?? byGroup.set(key, []).get(key)!).push(entry);
    }
    return GROUP_ORDER.filter((key) => byGroup.has(key)).map((key) => ({
      key,
      title: GROUP_TITLES[key] ?? key,
      entries: byGroup.get(key)!,
    }));
  }, [ready]);

  if (!open) return null;

  // Place a new node so it is always visible and never on top of another one:
  // beside the node it follows, else appended to the right of the rightmost
  // node, else in the middle of what the user is currently looking at.
  const positionFor = (): { x: number; y: number } => {
    const from = fromNodeId ? flow.nodes.find((node) => node.id === fromNodeId) : undefined;
    if (from?.position) return { x: from.position.x + 320, y: from.position.y };
    const placed = flow.nodes.filter((node) => node.position);
    if (placed.length > 0) {
      const rightmost = placed.reduce((a, b) => (a.position!.x >= b.position!.x ? a : b));
      return { x: rightmost.position!.x + 320, y: rightmost.position!.y };
    }
    const canvas = document.querySelector('.builder-canvas');
    const rect = canvas?.getBoundingClientRect();
    const screen = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: 400, y: 300 };
    const centre = screenToFlowPosition(screen);
    return { x: centre.x - 120, y: centre.y - 28 };
  };

  const add = (entry: CatalogueEntry) => {
    const target = positionFor();
    const id = flow.addNode({
      type: entry.type,
      label: String(entry.palette?.label ?? entry.type),
      // Seed schema defaults at creation so they persist and opening the
      // inspector never marks the node dirty.
      config: defaultsFor(entry.configSchema),
      position: target,
    });
    if (fromNodeId) flow.connect({ source: fromNodeId, target: id, sourceHandle: null });
    onClose();
    // Pan so the new step is visible - and clear of the inspector panel, which
    // floats over the right of the canvas when a node is selected. Keep the
    // current zoom; two frames so the node has mounted before we move.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const zoom = getZoom();
        const inspectorClearance = flow.selectedNodeId ? 540 : 0;
        setCenter(target.x + 120 + inspectorClearance / 2 / zoom, target.y + 28, {
          zoom,
          duration: 250,
        });
      }),
    );
  };

  const renderItem = (entry: CatalogueEntry, keyPrefix = '') => {
    // Lite-with-uplift: a 'both' entry with a capability gets the quiet cloud
    // glyph and a reveal row. The card still always adds the LOCAL step - the
    // reveal is a sibling, never inside the button (link-in-button is invalid
    // HTML), so clicking the card is never intercepted.
    const upliftable = cloudOn && entry.execution === 'both' && entry.entitlement;
    const entitled = upliftable && uplift.capabilities.includes(entry.entitlement!);
    const offer = upliftable
      ? uplift.offers.find((candidate) => candidate.id === entry.entitlement)
      : undefined;
    const item = (
      <button
        key={upliftable ? undefined : keyPrefix + entry.type}
        type="button"
        className="lib-item"
        aria-label={String(entry.palette?.label ?? entry.type)}
        onClick={() => add(entry)}
      >
        <span className={`chain-chip cat-${entry.category}`}>
          <Icon name={nodeIcon(entry.type, entry.category)} size={15} />
        </span>
        <span className="lib-info">
          <span className="lib-name">
            {String(entry.palette?.label ?? entry.type)}
            {upliftable && (
              <span
                className="up-glyph"
                role="img"
                aria-label={entitled ? 'Cloud connected' : 'Full version available in the cloud'}
              >
                <Icon name="cloud" size={14} fill={Boolean(entitled)} />
              </span>
            )}
          </span>
          <span className="lib-desc">{String(entry.palette?.description ?? '')}</span>
        </span>
      </button>
    );
    if (!upliftable) return item;
    return (
      <div className="lib-uplift" key={keyPrefix + entry.type}>
        {item}
        <div className="up-reveal">
          <div className="up-reveal-inner">
            <div className="up-strip">
              {entitled ? (
                <>
                  <span className="up-connected">
                    <Icon name="check" size={12} /> Cloud: connected
                  </span>{' '}
                  {'\u2014'} choose where this step runs in its settings.
                </>
              ) : (
                <>
                  Works here with smaller data. <b>Full version in the cloud</b>{' '}
                  {offer?.message ?? offer?.description ?? 'does more.'}
                  <br />
                  <Link className="up-link" to={`/account#${entry.entitlement}`}>
                    See what full adds {'→'}
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="library" role="dialog" aria-label="Add a step">
      <header className="lib-head">
        <h2>{fromNodeId ? 'Add the next step' : 'Add a step'}</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </header>
      <input
        className="search"
        placeholder="Find a step: email, webhook, code"
        aria-label="Find a step"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="lib-body">
        {searching && ranked.length === 0 && (
          <p className="lib-empty">No steps match &ldquo;{query.trim()}&rdquo;.</p>
        )}
        {searching && ranked.length > 0 && (
          <div className="lib-group">{ranked.map((entry) => renderItem(entry, "search"))}</div>
        )}
        {!searching && suggested.length > 0 && (
          <div className="lib-group lib-suggested">
            <h3 className="group-label">
              <Icon name="bolt" size={13} /> {suggestedTitle(fromCategory, hasNodes)}
            </h3>
            {suggested.map((entry) => renderItem(entry, 'sug'))}
          </div>
        )}
        {!searching && (
          <>
            {groups.map((group) =>
              OPEN_GROUPS.has(group.key) ? (
                <div className="lib-group" key={group.key}>
                  <h3 className="group-label">
                    <span className={`cat-dot dot-${group.entries[0]?.category ?? 'integration'}`} />{' '}
                    {group.title}
                  </h3>
                  {group.entries.map((entry) => renderItem(entry, group.key))}
                </div>
              ) : (
                <details className="lib-group lib-cat" key={group.key}>
                  <summary className="group-label">
                    <span className="cat-dot dot-integration" /> {group.title}
                    <span className="lib-count">{group.entries.length}</span>
                  </summary>
                  {group.entries.map((entry) => renderItem(entry, group.key))}
                </details>
              ),
            )}
            <div className="locked-group" aria-label="Available in Helix">
              {cloudOn && lockedOffers.length > 0
                ? lockedOffers.map((offer) => (
                    <Link className="locked-card" to="/account" key={offer.id}>
                      <span className="name">
                        <Icon name="cloud" size={15} /> {offer.title}{' '}
                        <span className="cloud-pill">Cloud only</span>
                      </span>
                      <span className="pitch">{offer.description}</span>
                      <span className="upgrade">Available in Helix {'→'}</span>
                    </Link>
                  ))
                : LOCKED_TIERS.map((tier) => (
                    <div className="locked-card" key={tier.name}>
                      <div className="name">
                        {tier.name} <span className="padlock">locked</span>
                      </div>
                      <div className="pitch">{tier.pitch}</div>
                      <span className="upgrade">Available in Helix</span>
                    </div>
                  ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
