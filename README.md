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

## Quickstart: docker compose (the hero path)

You need Docker. From the repository root:

```
docker compose -f compose/docker-compose.yml up --build
```

Open http://localhost:3000, sign in, and build your first workflow. The stack is
two containers, the official Temporal image and the Metis image, with SQLite in
a mounted volume so your work persists across restarts. Nothing reaches the
network beyond the two containers talking to each other.

## Quickstart: npx (the developer loop)

You need Node 22 or newer. In an empty directory:

```
npx @mindlynx/metis-cli init     # scaffold a project and a sample workflow
npx @mindlynx/metis-cli up        # start Temporal, the worker, the API and the editor
```

`metis up` downloads and manages the Temporal dev server the first time you run
it, so you never install Temporal by hand. The editor and API come up on port
3000, the Temporal Web UI on 8233. To run the sample workflow from the command
line instead:

```
npx @mindlynx/metis-cli run hello
```

> The npm packages are on their way to the registry. Until they land, run the
> CLI from source - same result, one extra step:
>
> ```
> git clone https://github.com/mindlynx-ai/metis.git && cd metis
> npm ci && npm run build
> node packages/metis-cli/dist/bin.js up
> ```

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
2. Sign in (the scaffold creates an `admin` user; the password is `metis`).
3. Click **Create your first workflow**.
4. From the left rail, add a **Webhook Start** trigger, then a **Code** step.
5. Click the code step and, in the panel on the right, set its code to
   `return { message: 'hello from metis' };`, then **Apply**.
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
npx @mindlynx/metis-cli connectors seed   # register the top-100 catalogue
npx @mindlynx/metis-cli connectors list    # tier, priority and wired-op count
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

The body is HMAC-signed (`x-metis-signature`) with the same scheme the inbound
side verifies, so one Metis validates another out of the box. Delivery retries
with backoff.

## Editions

Metis is the open core. Memory, agents, approvals, analytics and multi-tenant
teams are Helix capabilities that attach to the same engine through the same
ports and the plugin boundary; a workflow you build in Metis runs unchanged as
you climb. The palette shows these as locked cards so you can see the path.

## AI tools (MCP)

Metis ships an MCP server: `metis mcp` (or `npx @mindlynx/metis-cli mcp`)
lets Claude and other MCP-capable tools browse the node catalogue (docs
included), build workflows and run them against your instance. See
[docs/mcp.md](docs/mcp.md).

## Development

```
npm install
npm run typecheck     # workspace-wide types
npm run lint          # eslint, style and header checks
npm test              # unit and integration suites (Vitest)
npm run gates         # the six release gates
npm run e2e           # editor end-to-end (Playwright)
```

The data-gateway conformance suite runs against SQLite always and Postgres when
`PG_URL` is set. The browser-driven full run and the real Temporal boot are
gated behind `METIS_E2E=1`.

## Licence

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
