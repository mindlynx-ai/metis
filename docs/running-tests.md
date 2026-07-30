# Running the tests

```bash
npm ci                            # once, at the root (needs Node >=22.13 and a C++ toolchain)
npx playwright install chromium   # once, before the first e2e run
npm run typecheck                 # tsc across all packages
npm run lint                      # eslint + style checks
npm test                          # full unit suite (vitest)
npm run gates                     # the six release gates
npm run e2e                       # Playwright editor suite (self-hosting dev harness)
```

The browser download is a documented step rather than a `postinstall` because
it is ~150 MB that every contributor would pay for and most do not need on day
one. Without it `npm run e2e` fails at launch with "Executable doesn't exist".

## What runs where

- **Unit tests** live in each package's `__tests__/`. Pure logic is tested
  without any infrastructure.
- **Engine walk tests** (`packages/metis-engine/src/__tests__/*-walk.spec.ts`)
  execute REAL workflows on `@temporalio/testing`'s time-skipping
  `TestWorkflowEnvironment` with a real Worker - no external Temporal needed
  (the first run downloads the test server).
- **Editor e2e** boots its own control plane + Vite dev server on
  127.0.0.1:4181/:4180 (`packages/metis-editor/e2e/dev-core.ts`); no docker.
  Visual (screenshot) baselines are not tracked - they are platform-specific,
  so Playwright creates them on your machine the first time a visual spec
  runs (that first run reports "snapshot missing"; the second run compares).
- **System tests** (`npm run test:system`) exercise live paths; enable with
  `METIS_E2E=1`, and set `PG_URL` for the database cases.
- **Proof scripts** (`scripts/prove-webhook.sh`, `scripts/prove-schedule.sh`)
  drive a running stack end-to-end from the shell.

## Conventions

- TDD: the failing test lands with (or before) the change.
- UI features are proven by driving the UI (Playwright), not by API calls.
- The engine harness pattern to copy is
  `packages/metis-engine/src/__tests__/flow-nodes-walk.spec.ts`.
