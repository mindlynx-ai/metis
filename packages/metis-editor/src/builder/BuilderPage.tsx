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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { io } from 'socket.io-client';
import { api, ApiError, getToken, type CatalogueEntry } from '../api.js';
import { toast } from '../toast-store.js';
import { Icon } from '../ui/Icon.js';
import { useFlow } from '../flow-store.js';
import { ensureUplift, useUplift } from '../uplift-store.js';
import { useTheme } from '../theme.js';
import { BuilderCanvas } from './BuilderCanvas.js';
import { Inspector } from './Inspector.js';
import { Palette } from './Palette.js';
import { ConsentModal, type ConsentChoice } from './ConsentModal.js';
import { CloudWorkflowModal, DegradedBanner } from './CloudControls.js';
import { Modal } from './inspector/Modal.js';
import { statesFromLogs, type NodeRunStatus } from './run-paint.js';
import { timeAgo } from '../runs/format.js';

export function BuilderPage() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const flow = useFlow();
  const { theme, toggle: toggleTheme } = useTheme();
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [savedAt, setSavedAt] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [running, setRunning] = useState(false);
  // Live per-node run state, shown on the canvas so a Run never leaves the builder.
  const [runStates, setRunStates] = useState<Record<string, NodeRunStatus>>({});
  const [runBadges, setRunBadges] = useState<Record<string, string>>({});
  // Steps that were routed to the cloud but ran here instead + the run flag.
  const [runDegraded, setRunDegraded] = useState<Record<string, boolean>>({});
  const [degradedRun, setDegradedRun] = useState(false);
  // Run replay: ?run=<executionId> paints a FINISHED run's path onto the
  // canvas - taken steps coloured by outcome, orphaned branches greyed.
  const [searchParams] = useSearchParams();
  const replayRun = searchParams.get('run') ?? undefined;
  const [replayStatus, setReplayStatus] = useState<string>();
  useEffect(() => {
    if (!replayRun) {
      setReplayStatus(undefined);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchRun = () => {
      api
        .execution(replayRun)
        .then((detail) => {
          const { states, badges, degraded } = statesFromLogs(detail.logs);
          setRunStates(states);
          setRunBadges(badges);
          setRunDegraded(degraded);
          setDegradedRun(Boolean(detail.meta.degraded));
          setReplayStatus(detail.meta.status);
          // A run still in flight keeps painting: replay doubles as live watch.
          if (detail.meta.status === 'running') timer = setTimeout(fetchRun, 2000);
        })
        .catch(() => setReplayStatus('unknown'));
    };
    fetchRun();
    return () => clearTimeout(timer);
  }, [replayRun]);
  const runTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(runTimer.current), []);
  // Live overlay for runs started ANYWHERE (a webhook, a schedule, the runs
  // page): join the workflow's socket room and paint node states as engine
  // events stream in. The Run button's own 600ms poll still applies on top.
  useEffect(() => {
    if (!workflowId || replayRun) return undefined;
    const socket = io({
      path: '/ws/workflows',
      auth: { token: getToken() ?? '' },
      transports: ['websocket'],
    });
    const join = () => socket.emit('join', { room: `workflow:${workflowId}` });
    socket.on('connect', join);
    join();
    const STATUS_BY_EVENT: Record<string, NodeRunStatus> = {
      'workflow.node.started': 'running',
      'workflow.node.completed': 'completed',
      'workflow.node.failed': 'failed',
    };
    socket.on('workflow-event', (event: { name?: string; nodeId?: string }) => {
      const status = event.name ? STATUS_BY_EVENT[event.name] : undefined;
      if (status && event.nodeId) {
        setRunStates((current) => ({ ...current, [event.nodeId!]: status }));
      }
      if (event.name === 'workflow.execution.started') setRunStates({});
    });
    return () => {
      socket.disconnect();
    };
  }, [workflowId, replayRun]);

  const [libOpen, setLibOpen] = useState(false);
  // The workflow's cloud toggle lives behind the bar's cloud button; the
  // button itself only exists when the instance has a cloud at all.
  const uplift = useUplift();
  useEffect(ensureUplift, []);
  const [cloudOpen, setCloudOpen] = useState(false);
  // Versions panel: the changeset history from the store (pure read).
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<
    { version: number; changeset: number; status: string; updatedAt?: string; steps: number }[]
  >();
  const openVersions = () => {
    setVersionsOpen(true);
    if (workflowId) {
      api
        .workflowVersions(workflowId)
        .then((result) => setVersions(result.items))
        .catch(() => setVersions([]));
    }
  };
  // When the library was opened from a node's "+", the picked step connects
  // straight off that node's output.
  const [libFrom, setLibFrom] = useState<string | undefined>();

  const openLibraryAfter = useCallback((nodeId: string) => {
    setLibFrom(nodeId);
    setLibOpen(true);
  }, []);
  const closeLibrary = useCallback(() => {
    setLibOpen(false);
    setLibFrom(undefined);
  }, []);

  useEffect(() => {
    if (workflowId) {
      // Skip the reload when the store already holds this workflow: a
      // create-then-save navigates to the new id, and refetching there would
      // needlessly reset selection (closing the inspector mid-edit or -test).
      if (useFlow.getState().workflowId !== workflowId) {
        flow.load(workflowId).catch(() => undefined);
      }
    } else {
      // /workflows/new has no id param: start from a clean, empty canvas rather
      // than showing whatever workflow was last open.
      flow.reset();
    }
    api
      .catalogue()
      .then((result) => setCatalogue(result.entries))
      .catch(() => setCatalogue([]));
    // The zustand store instance is stable; loading is keyed by the
    // route param alone.
  }, [workflowId]);

  // Save creates a new workflow (server-assigned id) or updates the current
  // one; on create we move to its /edit URL so the id is in the route.
  const save = async () => {
    try {
      const id = await flow.save();
      setSavedAt(new Date().toISOString());
      toast.success('Draft saved');
      if (id && id !== workflowId) navigate(`/workflows/${id}/edit`, { replace: true });
      return id;
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'could not save the workflow';
      setRunError(message);
      toast.error(message);
      return undefined;
    }
  };

  // Poll the execution and paint each node's run state onto the canvas, so a Run
  // shows its progress in place - the builder never leaves for another page.
  const pollRun = useCallback(async (executionId: string, tries: number) => {
    try {
      const detail = await api.execution(executionId);
      const { states, badges, degraded } = statesFromLogs(detail.logs);
      setRunStates(states);
      setRunBadges(badges);
      setRunDegraded(degraded);
      setDegradedRun(Boolean(detail.meta.degraded));
      if (detail.meta.status !== 'running' || tries >= 25) {
        setRunning(false);
        if (detail.meta.status === 'failed') toast.error('Run failed - open a step to see why');
        else toast.success('Run finished');
        return;
      }
    } catch {
      // The execution may not be readable for a beat; keep polling.
    }
    runTimer.current = setTimeout(() => void pollRun(executionId, tries + 1), 600);
  }, []);

  // The consent gate: pending while the modal is up; the user's answer
  // resumes the run with it.
  const [consentAsk, setConsentAsk] = useState(false);

  // Run executes the current graph once, right now, and stays on the builder -
  // it does not publish, so a single action step (e.g. an email node) runs
  // without needing a trigger. Publishing is the separate Publish button.
  const run = async (consent?: ConsentChoice) => {
    // First cloud route of this workflow: ask before anything leaves this
    // computer. Run time only - the gate never appears while editing.
    if (flow.cloudRouting?.enabled && !flow.cloudRouting.consentAt && !consent) {
      setConsentAsk(true);
      return;
    }
    setRunError(undefined);
    setRunStates({});
    setRunDegraded({});
    setDegradedRun(false);
    setRunning(true);
    try {
      // "Don't ask again": stamp the consent on the workflow itself, so the
      // saved definition remembers; an unticked yes stays run-only below.
      if (consent?.decision === 'cloud' && consent.remember) {
        flow.setCloudRouting({ ...flow.cloudRouting, enabled: true, consentAt: new Date().toISOString() });
      }
      const id = await flow.save();
      setSavedAt(new Date().toISOString());
      if (!id) {
        setRunning(false);
        return;
      }
      // Put the new id in the URL (still on the builder), never the runs page.
      if (id !== workflowId) navigate(`/workflows/${id}/edit`, { replace: true });
      const routing = useFlow.getState().cloudRouting;
      const started = await api.startExecution({
        workflowId: id,
        definition: { nodes: flow.nodes, edges: flow.edges, cloudRouting: routing },
        input: {},
        ...(consent?.decision === 'cloud' && !consent.remember ? { cloudConsent: true } : {}),
      });
      toast.info('Run started');
      void pollRun(started.executionId, 0);
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'could not run the workflow';
      setRunError(message);
      toast.error(message);
      setRunning(false);
    }
  };

  // A graph with an API Start is a synchronous endpoint: it is published (not
  // "run"), then called over HTTP. Publish and show its callable URL.
  const apiStart = flow.nodes.find((node) => node.type === 'apiconfig');
  const apiPath = String((apiStart?.data?.config as { path?: unknown } | undefined)?.path ?? '').trim();

  const publish = async () => {
    setRunError(undefined);
    setRunning(true);
    try {
      const id = await flow.save();
      setSavedAt(new Date().toISOString());
      if (!id) return;
      await api.publishWorkflow(id);
      flow.setStatus('published');
      if (id !== workflowId) navigate(`/workflows/${id}/edit`, { replace: true });
      let message = `${flow.name} is live - Metis will run it on its trigger`;
      if (apiStart) {
        message = apiPath ? `API published - call POST /api/apiworkflow/${apiPath}` : 'API published';
      }
      toast.success(message);
    } catch (cause) {
      const raw = cause instanceof ApiError ? cause.message : 'could not publish the workflow';
      // Publishing makes a workflow run on its own trigger, so it needs one.
      // Point the user at a trigger (or Run, to just execute it once).
      const message = /trigger/i.test(raw)
        ? 'To publish, start the workflow with a trigger (a Schedule or Webhook). To run it once now, use Run.'
        : raw;
      setRunError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  const published = flow.status === 'published';
  let publishLabel = 'Publish';
  if (running) publishLabel = 'Publishing...';
  else if (apiStart) publishLabel = 'Publish API';

  return (
    <section className="builder" aria-label="Workflow builder">
      <div className="builder-bar b-head">
        <Link className="btn btn-icon b-back" to="/workflows" aria-label="Back to workflows">
          <Icon name="arrow-left" size={16} />
        </Link>
        <input
          className="builder-name-input b-name"
          value={flow.name}
          aria-label="Workflow name"
          onChange={(event) => flow.setName(event.target.value)}
        />
        <span className={`status b-status status-${published ? 'published' : 'draft'}`}>
          {published ? 'Published' : 'Draft'}
        </span>
        <span className="spacer" />
        {runError && (
          <span role="alert" className="run-error">
            {runError}
          </span>
        )}
        {flow.dirty && <span className="dirty-hint">Unsaved changes</span>}
        {savedAt && !flow.dirty && <span className="saved-hint">Saved</span>}
        <button
          type="button"
          className="btn btn-icon b-theme"
          aria-label="Switch color theme"
          onClick={toggleTheme}
        >
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} />
        </button>
        <span className="b-divider" aria-hidden="true" />
        {uplift.cloud !== 'disabled' && (
          <button
            type="button"
            className={`btn btn-icon b-cloud${flow.cloudRouting?.enabled ? ' on' : ''}`}
            aria-label="Cloud for this workflow"
            title="Cloud for this workflow"
            onClick={() => setCloudOpen(true)}
          ><Icon name="cloud" size={16} /></button>
        )}
        <button type="button" className="btn" onClick={openVersions}>
          <Icon name="clock" size={14} /> <span className="btn-txt">Versions</span>
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            save().catch(() => undefined);
          }}
        >
          <Icon name="save" size={14} /> <span className="btn-txt">Save draft</span>
        </button>
        {!apiStart && (
          <button
            type="button"
            className="btn btn-soft"
            disabled={running}
            onClick={() => {
              run().catch(() => undefined);
            }}
          >
            <Icon name="play" size={14} /> <span className="btn-txt">{running ? 'Running...' : 'Run'}</span>
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={running}
          onClick={() => {
            publish().catch(() => undefined);
          }}
        >
          <Icon name={apiStart ? 'plug' : 'send'} size={14} />{' '}
          <span className="btn-txt">{publishLabel}</span>
        </button>
      </div>
      {/* One React Flow provider around the whole body so the library (outside
          the canvas) can place new nodes in the current viewport. */}
      <ReactFlowProvider>
        <div className="builder-body">
          {/* Wait for the catalogue before mounting the canvas: otherwise the
              first render has placeholder node categories, and the recompute
              when the catalogue lands re-creates every node object
              mid-measurement, which races the edge rendering to nothing. */}
          {replayRun && (
            <div className="replay-banner" role="status">
              <span className={`status status-${replayStatus ?? 'running'}`}>{replayStatus ?? '…'}</span>
              <span>
                Viewing run <span className="mono">{replayRun}</span> on the canvas
              </span>
              <Link className="btn btn-sm" to={`/executions/${encodeURIComponent(replayRun)}`}>
                Run detail
              </Link>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setRunStates({});
                  setRunBadges({});
                  setRunDegraded({});
                  setDegradedRun(false);
                  navigate(`/workflows/${workflowId}/edit`);
                }}
              >
                Exit run view
              </button>
            </div>
          )}
          {degradedRun && !running && (
            <DegradedBanner
              belowReplay={Boolean(replayRun)}
              onSeeStep={() => { const nodeId = Object.keys(runDegraded)[0]; if (nodeId) flow.select(nodeId); }}
            />
          )}
          {catalogue.length > 0 && (
            <BuilderCanvas
              catalogue={catalogue}
              onAddAfter={openLibraryAfter}
              runStates={runStates}
              runBadges={runBadges}
              runDegraded={runDegraded}
            />
          )}
          <button
            type="button"
            className="btn btn-primary b-add"
            onClick={() => {
              setLibFrom(undefined);
              setLibOpen(true);
            }}
          >
            <Icon name="plus" size={16} /> Add step
          </button>
          {versionsOpen && (
            <Modal title="Versions" onClose={() => setVersionsOpen(false)}>
              <div className="versions-list">
                {versions === undefined && <p className="help">Loading…</p>}
                {versions?.length === 0 && <p className="help">No saved versions yet.</p>}
                {versions?.map((entry) => (
                  <div className="versions-row" key={`${entry.version}-${entry.changeset}`}>
                    <span className="mono">
                      v{entry.version}·c{entry.changeset}
                    </span>
                    <span className={`status status-${entry.status}`}>{entry.status}</span>
                    <span className="versions-when">
                      {entry.updatedAt ? timeAgo(entry.updatedAt, Date.now()) : ''}
                    </span>
                    <span className="versions-steps">{entry.steps} steps</span>
                  </div>
                ))}
              </div>
              <p className="help">
                Every save is a new changeset; publish marks the live one. Runs show which
                version they executed.
              </p>
            </Modal>
          )}
          {cloudOpen && <CloudWorkflowModal onClose={() => setCloudOpen(false)} />}
          {consentAsk && (
            <ConsentModal onChoose={(choice) => { setConsentAsk(false); run(choice).catch(() => undefined); }} />
          )}
          <Palette
            catalogue={catalogue}
            open={libOpen}
            onClose={closeLibrary}
            fromNodeId={libFrom}
          />
          <Inspector catalogue={catalogue} onSave={save} />
        </div>
      </ReactFlowProvider>
    </section>
  );
}
