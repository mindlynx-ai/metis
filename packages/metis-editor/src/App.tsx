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
 * The editor shell: top bar, routing and the identity
 * tokens live. The builder canvas, inspector, palette and run viewer
 * mount into this frame in the following iterations.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { getToken, api, type CatalogueEntry, type WorkflowItem } from './api.js';
import { toast } from './toast-store.js';
import { BuilderPage } from './builder/BuilderPage.js';
import { LoginPage } from './LoginPage.js';
import { Overview } from './Overview.js';
import { RunsPage } from './runs/RunsPage.js';
import { ExecutionPage } from './runs/ExecutionPage.js';

import { OperatePage } from './runs/OperatePage.js';
import { ConnectorsPage } from './ConnectorsPage.js';
import { AccountPage } from './AccountPage.js';
import { Shell } from './Shell.js';
import { chainPreview } from './workflow-chain.js';
import { categoryOf, nodeIcon } from './builder/node-visual.js';
import { ConfirmDialog } from './ui/ConfirmDialog.js';
import { Icon } from './ui/Icon.js';
import { Toasts } from './ui/Toasts.js';

/** The mini node-chain preview shown on a workflow card. */
function WorkflowChain({ workflow, catalogue }: { workflow: WorkflowItem; catalogue: CatalogueEntry[] }) {
  const { shown, overflow } = chainPreview(workflow.nodes ?? [], workflow.edges ?? [], 5);
  if (shown.length === 0) {
    return <span className="wf-chain wf-chain-empty" aria-hidden="true" />;
  }
  return (
    <span className="wf-chain" aria-hidden="true">
      {shown.map((node, index) => {
        const category = categoryOf(node.type, catalogue);
        return (
          <span className="chain-step" key={node.id}>
            {index > 0 && <Icon name="chevron" size={12} className="chain-arrow" />}
            <span className={`chain-chip cat-${category}`}>
              <Icon name={nodeIcon(node.type, category)} size={14} />
            </span>
          </span>
        );
      })}
      {overflow > 0 && <span className="chain-more">+{overflow}</span>}
    </span>
  );
}

/** Send an unauthenticated visit to /login instead of rendering a 401-ing shell. */
function RequireAuth({ children }: { children: ReactElement }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

/** An authed app view: the sidebar shell wraps the page. */
function AppView({ children }: { children: ReactElement }) {
  return (
    <RequireAuth>
      <Shell>{children}</Shell>
    </RequireAuth>
  );
}

function WorkflowsHome() {
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowItem>();
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);

  const refresh = () =>
    api
      .listWorkflows()
      .then((result) => setItems(result.items))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));

  useEffect(() => {
    void refresh();
    api
      .catalogue()
      .then((result) => setCatalogue(result.entries))
      .catch(() => undefined);
  }, []);

  const deleteWorkflow = async (workflow: WorkflowItem) => {
    try {
      await api.deleteWorkflow(workflow.id);
      toast.success('Workflow deleted');
    } catch {
      toast.error('Could not delete the workflow');
    }
    void refresh();
  };

  return (
    <main className="shell-main home-page" aria-label="Workflows">
      <header className="page-hero">
        <div>
          <h1 className="page-title">Workflows</h1>
          <p className="page-hero-sub">
            Build a flow from steps, run it, and watch every step as it happens. Connect
            services once and every workflow can use them.
          </p>
        </div>
        <Link className="btn btn-primary home-new-btn" to="/workflows/new">
          <Icon name="plus" size={14} /> New workflow
        </Link>
      </header>
      {!loaded && (
        <ul className="workflow-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton workflow-skeleton" />
          ))}
        </ul>
      )}
      {loaded && items.length === 0 && (
        <div className="conn-empty">
          <div className="conn-empty-mark" aria-hidden="true">
            <Icon name="workflow" size={28} />
          </div>
          <h2>No workflows yet</h2>
          <p>Start from a blank canvas: add steps, connect them, press Run.</p>
          <Link className="btn btn-primary" to="/workflows/new">
            Create your first workflow
          </Link>
        </div>
      )}
      {items.length > 0 && (
        <ul className="wf-list">
          {items.map((workflow) => {
            const steps = (workflow.nodes ?? []).length;
            return (
              <li key={workflow.id} className="wf-card">
                <Link className="wf-main" to={`/workflows/${workflow.id}/edit`}>
                  <WorkflowChain workflow={workflow} catalogue={catalogue} />
                  <span className="wf-info">
                    <span className="wf-name">
                      {workflow.name}
                      <span className={`status status-${workflow.status}`}>{workflow.status}</span>
                    </span>
                    <span className="wf-meta">
                      {steps} step{steps === 1 ? '' : 's'}
                      {workflow.type === 'api' ? ' · HTTP endpoint' : ''}
                    </span>
                  </span>
                  <Icon name="chevron" size={16} className="wf-go" />
                </Link>
                <span className="wf-side">
                  <Link className="btn btn-sm" to={`/workflows/${workflow.id}/runs`}>
                    <Icon name="clock" size={14} /> Runs
                  </Link>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => setConfirmDelete(workflow)}
                  >
                    Delete
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${confirmDelete.name}"?`}
          body="The workflow and its draft are removed from your list. Past runs stay visible in Operate."
          confirmLabel="Delete"
          onConfirm={() => {
            void deleteWorkflow(confirmDelete);
            setConfirmDelete(undefined);
          }}
          onCancel={() => setConfirmDelete(undefined)}
        />
      )}
    </main>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Toasts />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Full-screen surfaces: the builder owns the whole viewport. */}
        <Route path="/workflows/new" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="/workflows/:workflowId/edit" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        {/* Sidebar app views. */}
        <Route path="/" element={<AppView><Overview /></AppView>} />
        <Route path="/workflows" element={<AppView><WorkflowsHome /></AppView>} />
        <Route path="/workflows/:workflowId/runs" element={<AppView><RunsPage /></AppView>} />
        <Route path="/executions/:executionId" element={<AppView><ExecutionPage /></AppView>} />
        {/* History merged into Operate; old links keep working. */}
        <Route path="/history" element={<Navigate to="/operate" replace />} />
        <Route path="/operate" element={<AppView><OperatePage /></AppView>} />
        <Route path="/connectors" element={<AppView><ConnectorsPage /></AppView>} />
        <Route path="/account" element={<AppView><AccountPage /></AppView>} />
      </Routes>
    </BrowserRouter>
  );
}
