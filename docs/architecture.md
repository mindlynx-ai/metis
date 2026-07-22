# Architecture

Metis is a TypeScript monorepo around one idea: **the workflow definition is
data, Temporal makes it durable, and every substrate is behind a port.**

```
 Browser (metis-editor)
    | HTTP + WebSocket
 metis-core (control plane: auth, CRUD, catalogue, connections)
    |                         \
 metis-orchestrator            metis-data-gateway (SQLite/Postgres)
 (Temporal client, schedules,
  socket hub, triggers)
    |
 Temporal server
    |
 metis-engine worker (helixWorkflow + activities)
    |
 metis-nodes handlers (HTTP, code sandbox, data sources, connectors)
```

## The packages

| Package | What it is |
|---|---|
| `metis-ports` | The seams: NodeExecPort, CredentialPort, DataSourcePort, EventSink, IdentityPort, ExecutionPort + in-memory fakes. Everything depends on ports; ports depend on nothing. |
| `metis-catalogue` | Node types and connectors **as data**: `nodeTypes.v1.json` (config/output schemas, palette, docs) + the connector registry. The editor renders from it; the engine validates against it. |
| `metis-engine` | The Temporal worker. `helixWorkflow` walks the definition as a one-shot DAG (waves, fan-in joins, orphan cascades); inline control nodes (switch/logic/loop/filter/merge/...) run in the dispatch activity; the Loop spawns real child workflows. Activities are the only substrate access. |
| `metis-nodes` | Open node handlers: HTTP/api, sandboxed code, the Data node's Postgres adapter, SendGrid, generated connector handlers. |
| `metis-core` | The control-plane HTTP surface: auth + sessions, workflow CRUD, executions, connections (write-only credentials), the data-resource routes, catalogue serving. |
| `metis-orchestrator` | The Temporal client side: execution adapter (start/signal/cancel/describe/list), schedule service, the Socket.IO hub streaming engine events, trigger services. |
| `metis-data-gateway` | Storage behind one gateway: SQLite for the laptop, Postgres for real deployments. Workflow store, execution logs, connections. |
| `metis-cli` | `npx @mindlynx/metis-cli` - init/up/dev; downloads and manages a local Temporal dev server; collapses core+orchestrator+worker into one process for the laptop. |
| `metis-editor` | The React app: React Flow canvas, schema-driven inspectors, runs pages. |

## Key invariants

- **Generic I/O**: a node receives the run's state and gives one payload; only
  its config is typed. Downstream steps reference outputs as
  `{{node-<id>.data.<path>}}`, substituted in the dispatch activity.
- **Determinism**: workflow code never touches substrate; anything
  non-deterministic happens in activities and rides Temporal history.
- **Branching**: branch nodes return selected/orphaned target sets; the walker
  orphans losing branches (skipped, not failed) with convergence protection.
- **Payload discipline**: node outputs are capped (the data node ~256 KB) so
  state survives Temporal's payload limits; big data travels as references.
- **Retention**: Metis's store keeps execution history for `retentionDays`
  (metis.config.json, default 90) - far beyond the Temporal dev server's
  visibility window. Operate's Archive lists runs Temporal has forgotten;
  their detail pages stay fully inspectable from the store.
- **Editions**: the open build is complete and self-contained; gated
  capabilities exist only as locked cards. Six release gates enforce the
  boundary structurally.

## Where things happen

- Engine walk: `packages/metis-engine/src/workflows/helixWorkflow.ts`
- Node dispatch + substitution: `packages/metis-engine/src/activities/create-activities.ts`
- Definition validation (incl. cycle + loop rules): `packages/metis-engine/src/validation.ts`
- Control-plane routes: `packages/metis-core/src/*.ts`
- Live events: engine activities emit -> `LocalEventBus` -> socket hub
  (`packages/metis-orchestrator/src/socket-hub.ts`) -> the editor.
