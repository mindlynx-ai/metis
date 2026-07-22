# Adding a node type

A Metis node is data plus a handler. The catalogue entry declares what a node
is (config schema, output schema, palette); the handler says what it does at
run time. Inputs and outputs are deliberately generic - a node receives the
run's state and gives one payload - only its configuration is typed.

## 1. Declare it in the catalogue

Add an entry to `packages/metis-catalogue/src/nodeTypes.v1.json`:

```json
{
  "type": "mynode",
  "category": "transform",
  "execution": "inline",
  "versions": ["1.0.0"],
  "status": "v1",
  "tier": "open",
  "configSchema": {
    "type": "object",
    "required": ["message"],
    "properties": {
      "message": { "type": "string", "title": "Message", "description": "Shown in the inspector as field help." }
    }
  },
  "outputSchema": { "type": "object", "properties": { "result": { "type": "string" } } },
  "handler_status": "ready",
  "palette": { "label": "My Node", "icon": "bolt", "colour": "sky-500", "description": "One honest sentence about what it does." }
}
```

- `category` is one of `trigger | logic | transform | integration`.
- `outputSchema` powers the variable picker: downstream steps offer
  `{{node-<id>.data.<field>}}` chips from it.
- Add search keywords in `packages/metis-catalogue/src/loader.ts`
  (`BASE_NODE_META`) so the picker finds it by synonym.

## 2. Implement the handler

Two kinds:

- **Handler nodes** (most nodes: API calls, email, database) - register a
  `NodeHandler` in `packages/metis-nodes/src/register.ts`. The handler gets the
  node's already-substituted config (`{{...}}` references resolved) and returns
  `{ status, message, nodeData }` - use `stateEnvelope()` for the success shape.
  Policy (retries/backoff/timeout) is applied for you.
- **Inline control nodes** (branching, joining, iteration) - these run inside
  the engine's dispatch activity. See `packages/metis-engine/src/nodes/` for
  the pattern (`switch.ts`, `merge.ts`, `flow-inline.ts`). Branch-shaped nodes
  return `selectedTargetIds`/`orphanedTargetIds` so losing branches are
  orphaned.

## 3. Canvas + inspector

- The inspector renders from `configSchema` automatically (text, select,
  number, JSON fields; `description` becomes field help). Only build a bespoke
  widget when a schema form genuinely cannot express the config - see
  `x-helix-widget` and `packages/metis-editor/src/builder/inspector/`.
- If the node branches, give its handles the ids the engine routes by in
  `packages/metis-editor/src/builder/node-visual.ts` (`outputPorts`). A
  mismatched handle id means an edge the user draws points at a branch that
  never fires.

## 4. Tests (the definition of done)

- A unit test for any pure logic.
- A walk test through the real engine on `@temporalio/testing`'s
  `TestWorkflowEnvironment` - copy the harness in
  `packages/metis-engine/src/__tests__/flow-nodes-walk.spec.ts`.
- An editor e2e that adds the node from the picker and round-trips its config
  (`packages/metis-editor/e2e/`).
- `npm run typecheck && npm run lint && npm test && npm run gates && npm run e2e`
  all green. The coverage test (`node-coverage.spec.ts`) fails the build if a
  catalogue type has no execution path - update its inline list for engine
  nodes.
