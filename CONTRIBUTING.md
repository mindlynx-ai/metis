# Contributing to Metis

Thanks for looking under the hood. Metis is a TypeScript monorepo; everything
runs with Node (see `.nvmrc`) and `npm install` at the root.

## The quality bar (what CI runs)

Every change must keep this green - it is exactly what `.github/workflows/ci.yml` runs:

```bash
npm run typecheck     # tsc across all packages
npm run lint          # eslint + style checks (no em dash, no deferred-work markers)
npm run check:headers # Apache-2.0 header on every source file
npm run gates         # the six release gates (see below)
npm test              # the full unit suite (vitest)
npm run release-audit # pre-release leak sweep
```

CI also boots the full docker compose stack on an egress-blocked network and
curls it - the "does a fresh clone actually run" check.

### The release gates

`npm run gates` runs six structural checks that keep the open edition honest:

1. **Module boundary** - open packages never import gated modules.
2. **No AWS SDK** - the open build has no cloud-vendor dependency.
3. **Catalogue tier** - only `tier: "open"` node types ship.
4. **Identifier scan** - a leak scanner for infra names and secrets.
5. **Standalone boot topology** - compose runs only Temporal + Metis.
6. **Doc allowlist** - only intentional markdown ships (internal planning
   docs cannot slip into the public tree).

## Tests

- **Unit**: `npm test` (vitest, per-package `__tests__/`).
- **Engine walk tests** run real Temporal workflows on
  `@temporalio/testing`'s `TestWorkflowEnvironment` - copy the harness in
  `packages/metis-engine/src/__tests__/flow-nodes-walk.spec.ts`.
- **Editor e2e**: `npm run e2e` (Playwright; boots its own dev harness on
  :4180/:4181, no docker needed). `npm run e2e:full` for the long suite.
- **System tests**: `npm run test:system` (needs `METIS_E2E=1`; database
  cases need a `PG_URL`).
- Live-path proof scripts: `scripts/prove-webhook.sh`, `scripts/prove-schedule.sh`.

## Adding things

- New node type: read `docs/adding-a-node.md` first.
- New connector: connectors are data - see `docs/connectors.md`.
- Node docs: edit the `docs` field in
  `packages/metis-catalogue/src/nodeTypes.v1.json`, then regenerate the
  reference with `node scripts/generate-node-docs.mjs`.

## Style

- TypeScript strict; eslint + sonarjs rules are enforced (cognitive
  complexity 15, max 400 lines/file).
- Every source file carries the Apache-2.0 header.
- Comments explain WHY, matching the density you see around you.
