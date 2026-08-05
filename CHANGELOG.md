# Changelog

## Unreleased

Everything below is in `main` and in no published package. Metis has never been
released to npm and carries no git tag, so **no released version is affected by
any security entry here, and there is nothing to upgrade from.** If you run
Metis from a source checkout or a locally-built image, pull.

The security fixes are described plainly rather than vaguely. They are already
public in this repository's history, so being coy would hide the impact from
the only people who need to judge it - self-hosters - while hiding nothing from
anyone reading the diffs.

### Security

Three of these change behaviour you may be relying on; they are marked
**breaking**.

- **The published default admin secret is refused (breaking).** The built-in
  secret is `metis` and it is printed in this repository, so an instance left
  on it had no authentication worth the name. `METIS_ADMIN_SECRET` must now be
  set to something else or the process exits non-zero *before it binds a port*.
  The refusal is unconditional: the previous `METIS_ENV=production` condition
  is gone, because an exposed instance is rarely the one with `METIS_ENV` set.
  The one opt-out is `METIS_INSECURE_DEMO=true`, exactly that string, which the
  shipped compose stack sets deliberately.
- **The editor and API listen on `127.0.0.1` by default (breaking).**
  Previously they bound every interface, so `metis up` on a laptop on a shared
  network served that whole network. Serving other machines is now the explicit
  `METIS_HOST=0.0.0.0`, which also prints a warning. Inside a container the
  process still binds `0.0.0.0` - it must, or a published port could not reach
  it - and the compose file pins its published ports to `127.0.0.1` instead.
- **The static file server could be walked out of its own directory.** The
  editor bundle is served from outside the bearer gate, so this was reachable
  by anyone who could reach the port. Percent-encoded traversal resolved to
  files beside the editor, including `.metis/credential.key` - the key to the
  credential vault. Every candidate path is now resolved and required to sit
  under the editor directory, and the containment check runs before the
  extension check, so a traversal is refused outright rather than falling
  through.
- **The data-resource routes now require `edit` (breaking).**
  `GET /api/data/tables`, `POST /api/data/validate`,
  `GET /api/data/tables/:table/columns` and the two connection-test routes were
  ungated. `/api/data/validate` plans and evaluates caller-supplied SQL through
  stored credentials, so the lowest-privilege signed-in account could enumerate
  a connected database and run SQL against it. A `viewer` can no longer reach
  any of the five. `requireAction('view')` would not have helped: every role
  has `view`, so it means only "signed in".
- **The credential vault is published by rename, not by truncation.** Every
  credential write decrypts, mutates and re-encrypts the whole vault, and the
  old write truncated the file first. A crash inside that window destroyed
  every stored credential at once, unrecoverably. Writes now go to a temporary
  file in the same directory, are fsynced, and are published with an atomic
  rename.
- **Every outbound call has a deadline, and token resolution is inside it.**
  Both cloud clients resolved a bearer token *before* starting their own
  timeout, so a hung identity server hung every call indefinitely despite the
  ten seconds the code appeared to have. Deadlines are now per-call and chosen
  per operation - a token exchange and a Temporal binary download are not the
  same deadline. Postgres connection acquisition was unbounded and is now ten
  seconds, with a ninety-second `statement_timeout`.
- **A retried webhook delivery runs the graph once, not twice.** A sender
  retrying a delivery it never saw acknowledged started a second run.
  Deliveries now derive a deterministic workflow id, so a replay is
  deduplicated by Temporal rather than executed.
- **A stale reconcile no longer overwrites a failed run as completed**, which
  had made a failure disappear from history.
- **Activity retries are bounded**, and the log no longer hides the second
  attempt behind the first.
- **A slow first Temporal connect no longer poisons the process permanently.**
  The client holder cached the failure, so one slow start meant every later
  call failed until a restart.
- **Postgres node results are capped** at 1000 rows or 256 KiB, whichever binds
  first, reusing the cap every data-source adapter already applied. An uncapped
  result rode the workflow state on every hop and could exceed Temporal's
  payload limit. Writes are untouched - `rowCount` is rows affected, which a
  cap has nothing to say about.
- **An internal failure is logged rather than swallowed**, and no longer names
  its own database in the response.

### Fixed

- Two of the six release gates passed without checking their input, and gate 5
  passed a compose file it could not parse. A gate that cannot look now reports
  failure instead of success. Gate 5 reads every `compose/*.yml` rather than one
  hardcoded name, and catches a published port on any bind address, not only the
  loopback spelling. Gate 6 reads git's index rather than walking the
  filesystem, so it no longer skips the one directory it exists to police.
- Gate 4 now scans rendered SVGs. A diagram stores every label as literal text,
  so an internal hostname or product name drawn into a box would have shipped
  unread.
- The documented from-source path works for someone who has never seen the
  repository. The built CLI binary is now made executable, so `npx metis`
  resolves from a source checkout instead of failing on a permission error.
- The Data step's documentation no longer names an internal product.

### Changed

- **Packages ship `dist` only.** Every package published its `src` as well,
  roughly doubling each tarball for no benefit.
- **The SQL Server driver is optional.** It reaches `tedious`,
  `@azure/identity` and a browser MSAL bundle, about 60 MB, so
  `npm ci --omit=optional` is supported and leaves everything except SQL Server
  working. Connections for an engine with no adapter store and display as
  locked rather than failing.
- The Node floor is **22.13**, not 22.12: the default datastore is
  `node:sqlite`, which was behind `--experimental-sqlite` until then, so 22.12
  boots and then throws.
- Execution history is kept **indefinitely**. `retentionDays` is stamped on
  each row as a TTL attribute for a store that expires rows on its own, and
  neither SQLite nor Postgres does, so nothing prunes. The Archive no longer
  claims a window it does not enforce.

### Documentation

- `docs/architecture.md` carries four diagrams - package topology, a run end to
  end, the port and edition boundary, and trust boundaries - as mermaid, with
  committed SVG renders in `docs/diagrams/` and
  `node scripts/render-diagrams.mjs` to regenerate them.
- The docs site renders mermaid; it previously printed the diagram source as a
  code block.
- `SECURITY.md` described an admin-secret refusal conditioned on `METIS_ENV`
  that no longer exists, and did not mention `METIS_INSECURE_DEMO` at all.

## 0.1.0 - initial open-source release

The first public release of Metis: a workflow builder for developers who want
durable execution on Temporal without writing worker code first.

- Visual builder (React Flow canvas + schema-driven inspectors) with the
  Helix-compatible workflow shape.
- Durable engine on Temporal: one-shot DAG walk, per-node policies
  (retries/backoff/timeout/continue-on-failure), signals, durable waits.
- Control-flow nodes: Switch (multi-way), Logic (AND/OR/NOT on trigger
  input), Loop (one Temporal child workflow per iteration), Filter,
  Compare Datasets, Merge, No Operation, Stop and Error, Wait Until, Signal.
- Data node: SQL or a visual query builder against pluggable data sources
  (Postgres in the open edition), live validation that publishes result
  columns as downstream variables, capped inline results and dataset
  references.
- Connectors-as-data with a bring-your-own-credentials boundary; webhook,
  schedule and API triggers; outbound webhooks; run history with live
  WebSocket updates.
- In-app node Guide docs, generated node reference, six release gates,
  full unit + e2e + system test suites.
