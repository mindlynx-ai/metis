# Metis

Metis is an open-source workflow engine. You draw a flow of steps, run it, and
watch every step as it happens. Under the hood it is durable: powered by
[Temporal](https://temporal.io), a workflow survives crashes, restarts and long
waits without losing its place. Metis is Apache-2.0, runs entirely on your
machine, and needs no cloud account and no AWS.

- A visual, single-tenant node-graph editor (light and dark, keyboard operable).
- Open node categories: triggers, logic, transform and integration steps
  (HTTP, a sandboxed code step, Postgres, email, and a generic connector).
- SQLite by default, Postgres when you want it, both through one data gateway.
- A CLI that downloads and manages the Temporal dev server for you.

## Prerequisites

The compose path needs **Docker** and nothing else. Running from source needs:

- **Node 22.13 or newer.** The default datastore is `node:sqlite`, which was
  behind `--experimental-sqlite` until 22.13, so 22.12 boots and then throws.
  `.nvmrc` pins the version this is developed on.
- **A C++ toolchain, unless your platform has a prebuild.** The Code step runs
  in a real V8 isolate (`isolated-vm`), a native addon. It ships prebuilt
  binaries for Apple Silicon macOS, Linux x64 and arm64 (glibc and musl) and
  Windows x64, on Node 22 and 24, and those installs compile nothing. Anything
  else (an Intel Mac, an odd Node version) falls back to `node-gyp rebuild`,
  which needs Python and a compiler or `npm ci` fails on the spot. macOS:
  `xcode-select --install`. Debian or Ubuntu:
  `apt install -y build-essential python3`. Windows: the "Desktop development
  with C++" workload from Visual Studio Build Tools.
- **Docker**, if you want the compose stack rather than the CLI's own Temporal
  dev server.

The SQL Server driver is optional. It is installed by default, but it reaches
`tedious`, `@azure/identity` and a browser MSAL bundle, about 60 MB, so
`npm ci --omit=optional` is supported and leaves everything except SQL Server
working. That engine then behaves like any other Metis does not carry an
adapter for: its connections store and show as locked rather than failing.

Three ports have to be free: **3000** (editor and API), **7233** (Temporal
gRPC) and **8233** (the Temporal Web UI). All three move in
`metis.config.json` under `ports`, and that file may hold only the keys you
are changing:

```json
{ "ports": { "temporalGrpc": 7333, "temporalUi": 8333 } }
```

If you already run a Temporal, move 7233 before you start. The dev server logs
`can't set frontend port 7233: bind: address already in use` and carries on, so
`metis up` still says it is up while the worker talks to whichever Temporal
already had the port.

## Quickstart: docker compose (the hero path)

You need Docker. From the repository root:

```
docker compose -f compose/docker-compose.yml up --build
```

Open http://localhost:3000, sign in, and build your first workflow. The stack is
two containers, the official Temporal image and the Metis image, with SQLite in
a mounted volume so your work persists across restarts.

Both published ports are bound to `127.0.0.1`, so the editor and API are reachable
from your machine and not from the rest of your network. The compose stack also
sets `METIS_INSECURE_DEMO=true`, which permits the well-known default admin
secret because it is a throwaway local stack. **Before you put this anywhere
other people can reach, set `METIS_ADMIN_SECRET` and drop that flag** - the
default is published in this repository, so it is not a secret at all. Serving
other machines deliberately is `METIS_HOST=0.0.0.0` plus a port mapping you
choose.

## Quickstart: from source (the developer loop)

```
git clone https://github.com/mindlynx-ai/metis.git && cd metis
npm ci && npm run build
export METIS_ADMIN_SECRET=pick-your-own
node packages/metis-cli/dist/bin.js init   # scaffold a project and a sample workflow
node packages/metis-cli/dist/bin.js up     # Temporal, the worker, the API and the editor
```

`up` downloads and manages the Temporal dev server the first time you run it,
so you never install Temporal by hand. The editor and API come up on port 3000,
the Temporal Web UI on 8233. Sign in as `admin` with the secret you exported.
To run the sample workflow from the command line instead:

```
node packages/metis-cli/dist/bin.js run hello
```

`METIS_ADMIN_SECRET` is not optional: the built-in default is published in this
repository, so Metis refuses to serve on it unless you say
`METIS_INSECURE_DEMO=true` and mean it.

The rest of this page writes CLI commands as plain `metis ...`. From a source
checkout that is `npx metis ...` at the repository root - `npm run build` links
the workspace binary, so npx finds it without a global install.

> **The npx-from-the-registry route is not live yet.** Once the packages reach
> npm the two commands above become `npx @mindlynx/metis-cli init` and
> `npx @mindlynx/metis-cli up`, with `npx @mindlynx/metis-cli run hello` to run
> one workflow. Today those return a 404: nothing under `@mindlynx` is
> published. Use the source path.

## What is Temporal, and why is it here?

A normal script that calls three services in a row has a problem: if the machine
dies after the second call, the third never happens and nobody knows. Temporal
solves this. It runs your workflow as durable code: every step is recorded, so
if the process crashes or the machine restarts, Temporal replays the history and
your workflow continues exactly where it left off. A step can wait for a signal
or sleep for a day, and the wait costs nothing and survives anything. That is why
a Metis workflow can pause for an approval, run a nightly schedule, or retry a
flaky API call without you writing a single line of plumbing. Metis keeps
Temporal in the open core because durability is the whole point of a workflow
engine, not an add-on. You do not need to learn Temporal to use Metis: the CLI
manages the dev server, and the editor hides the mechanics. It is simply the
reason your workflows are reliable.

## Your first workflow (no Temporal knowledge needed)

1. Run `metis up` and open http://localhost:3000.
2. Sign in as `admin` with your `METIS_ADMIN_SECRET`.
3. Click **Create your first workflow**.
4. From the left rail, add a **Webhook Start** trigger, then a **Code** step.
5. Click the code step and, in the panel on the right, set its code to
   `return { message: 'hello from metis' };`, then **Save**.
6. Drag from the trigger's right dot to the code step's left dot to connect them.
7. Click **Run**. You land on the run viewer and watch the run turn green, with
   the code step's result shown beneath it.

That is a durable workflow. Add an HTTP step, a Postgres query or a branch, and
the same Run button carries it through.

## Connectors

A connector is data, not code: one generic connector node dispatches against a
registered definition (base URL, auth scheme and a catalogue of named
operations). Metis ships the top 100 most-popular integrations as definitions;
seed them into your project with:

```
metis connectors seed   # register the top-100 catalogue
metis connectors list   # tier, priority and wired-op count
```

The most-used connectors (Slack, GitHub, HubSpot, Notion, Stripe, and more) ship
with real operations wired, so a connector node just names the operation and its
params, e.g. `{ connectorId: "slack", operation: "postMessage", params: { channel, text } }`.
Every definition runs bring-your-own-credentials; the credential material lives
behind the credential boundary, never in the workflow. The rest of the catalogue
is browsable and fills in over time.

## Triggers

Workflows start three ways, all on Temporal (no external queue):

```
metis triggers add webhook  <workflow> --connector github --event push --secret <s>
metis triggers add poll     <workflow> --connector hubspot --operation listContacts --cursor createdAt
metis triggers add schedule <workflow> --cron "0 9 * * 1"
```

- **Webhook** - an external app POSTs to `/hooks/:triggerId`; Metis verifies the
  signature (GitHub `x-hub-signature-256` or a generic HMAC), normalises the
  payload and starts the workflow.
- **Poll** - for apps without webhooks, Metis calls a connector operation on a
  cadence, tracks a cursor, and starts one run per new item.
- **Schedule** - a native Temporal Schedule fires the workflow on a cron.

## Outbound webhooks

Send a signed POST to your own systems on every workflow lifecycle event:

```
metis webhooks add https://ops.example.com/metis --events completed,failed --secret <s>
```

`x-metis-signature` is `base64(HMAC_SHA256(secret, "<delivery-id>.<timestamp>.<body>"))`,
over the `x-metis-delivery` and `x-metis-timestamp` headers sent beside it -
the same scheme the inbound side verifies, so one Metis validates another out
of the box. `x-metis-timestamp` is unix seconds and a delivery more than five
minutes old is refused, so a captured one cannot be replayed later; signing the
delivery id keeps a replay from being relabelled into a fresh run. Delivery
retries with backoff.

## Sessions and sign-in

Signing in returns an opaque bearer token held in the server's memory. How long
one lasts, and how hard it is to guess a password, are yours to set - Metis is
yours to run. They live under `auth` in `metis.config.json`, and like every
other block that file may hold only the keys you are changing:

```json
{ "auth": { "sessionIdleHours": 1, "loginAttempts": 5 } }
```

| Key | Default | What it does |
|---|---|---|
| `sessionAbsoluteHours` | `24` | Hard ceiling on a session, measured from sign-in. Using it does not extend it. |
| `sessionIdleHours` | `8` | Silence that ends a session early. Set it **below** `sessionAbsoluteHours` or it can never be the thing that expires anything. |
| `maxSessions` | `10000` | Live sessions kept in memory. Past this the oldest is dropped, so a flood of sign-ins costs bounded memory. |
| `loginAttempts` | `10` | Failed sign-ins allowed per window, per source address **and** username. Successes are not counted and clear the tally. |
| `loginWindowMinutes` | `15` | How long that window lasts. Once it passes, the allowance returns. |

Both deadlines are checked when a token is *used*, so a token cannot outlive
its window because a background sweep has not come round yet. `POST
/api/auth/logout` (the editor's "Sign out") revokes immediately rather than
marking anything for later.

The defaults expire on purpose. "Never expires" is exactly the setting nobody
knows they have, and before this a captured token stayed valid until the
process restarted.

Two things the sign-in limit does not do, worth knowing before you rely on it.
It gives every source address its own allowance, so it slows one attacker and
not a distributed one. And it reads `request.ip`: **behind a reverse proxy
without Fastify's `trustProxy`, every request appears to come from the proxy**,
the address half of the key collapses to a constant, and the limit degrades to
one an attacker can use to lock a named user out. Terminate TLS in front of
Metis by all means, but configure the proxy headers if you do.

## Editions

Metis is the open core. Memory, agents, approvals, analytics and multi-tenant
teams are Helix capabilities that attach to the same engine through the same
ports and the plugin boundary; a workflow you build in Metis runs unchanged as
you climb. The palette shows these as locked cards so you can see the path.

## AI tools (MCP)

Metis ships an MCP server: `metis mcp` lets Claude and other MCP-capable tools
browse the node catalogue (docs included), build workflows and run them against
your instance. See [docs/mcp.md](docs/mcp.md).

## Development

```
npm ci
npx playwright install chromium   # once, before the first e2e run
npm run typecheck     # workspace-wide types
npm run lint          # eslint, style and header checks
npm test              # unit and integration suites (Vitest)
npm run gates         # the six release gates
npm run e2e           # editor end-to-end (Playwright)
```

Playwright's browser is a separate ~150 MB download, so it is a documented step
rather than a `postinstall`: everybody installing the workspace would pay for it,
and almost nobody runs the e2e suite on their first afternoon.

The data-gateway conformance suite runs against SQLite always and Postgres when
`PG_URL` is set. The browser-driven full run and the real Temporal boot are
gated behind `METIS_E2E=1`.

## Licence

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
