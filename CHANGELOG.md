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

Five of these change behaviour you may be relying on; they are marked
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
- **Calling a published API workflow requires `edit` (breaking).**
  `/api/apiworkflow/*` had no action gate, so the lowest-privilege signed-in
  account could run any published api-type workflow synchronously and read its
  response - meaning it could cause whatever that graph causes: outbound HTTP
  calls, database writes, email. It is the third finding of this shape, so the
  test suite now enumerates every registered route and holds the ungated ones
  against a named list, rather than checking the route that was reported.
- **Run lifecycle routes check the run belongs to the caller.** Terminate,
  reset, signal, cancel, status, describe and insight took the id out of the
  URL and handed it to Temporal unexamined. Temporal's namespace is not the
  product's boundary: a workflow Metis never started could be terminated,
  signalled or described by anyone signed in. Each route now requires the run
  to be in this instance's store under the caller's tenant. The store row is
  written by the run's first activity, so a run cancelled in the same breath as
  it was started can answer 404 until the worker picks the task up.
- **The generic webhook signature covers the timestamp and the delivery id
  (breaking).** The `hmac` scheme signed the body alone: nothing dated a
  delivery, so a captured one stayed valid as long as the secret did. The
  delivery id was worse than merely unsigned - it decides the execution id, and
  therefore whether a repeat is recognised as a repeat, so editing that one
  header replayed a captured request as a brand-new run under a signature that
  still verified. Both directions now sign `deliveryId.timestamp.body`, the
  construction the Svix path already used, and hold the timestamp to the same
  five-minute window. `x-metis-timestamp` is unix seconds and is the time the
  request was sent. **A sender signing the old way is refused**; there is no
  dual-accept window, because a receiver that still accepted a body-only
  signature could not tell a legacy sender from a replay - the attacker simply
  omits the timestamp - so the window would leave the hole fully open for its
  whole length. Update senders, or set the trigger to `verification: none` if
  you genuinely cannot.
- **An SSRF-refused URL is no longer echoed into the run log.** The node's
  failure message named the whole URL, and the URL reaching the node has
  already had `{{secrets.*}}` resolved, so a target like
  `https://api.example/v1?key=<secret>` wrote a live key into the execution log
  and the Temporal event history, where a viewer could read it. Refusals now
  name scheme and host only.
- **The SSRF guard reads addresses as numbers, not as text.** It matched string
  prefixes, and `new URL()` never gives it the spelling those prefixes expect:
  `http://[::ffff:169.254.169.254]/` arrives as `[::ffff:a9fe:a9fe]`, which
  matched nothing, so the cloud metadata service, loopback and every RFC1918
  range were reachable through their IPv4-mapped and IPv4-compatible IPv6
  forms. Addresses are now parsed and tested as integer ranges, both IPv6 forms
  that embed IPv4 are reduced to that address first, and the blocklist gains
  CGNAT (`100.64.0.0/10`), the IETF protocol block (`192.0.0.0/24`),
  benchmarking (`198.18.0.0/15`), multicast, reserved and the NAT64 prefix
  (`64:ff9b::/96`). An address the guard cannot parse is now blocked rather
  than allowed. Four modules share this guard, so the fix covers every
  author-supplied URL the product fetches, not just the http node.
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

### Added

- **Metis runs on Windows.** `metis up` was refused outright on any platform
  that was not macOS or Linux, and the refusal pointed the reader at a README
  section about WSL that has never existed. Temporal publishes a Windows
  `.tar.gz` beside the darwin and linux ones and Windows 10 1803+ ships bsdtar,
  so the dev server is now downloaded, checksum-verified and booted natively
  there too. No WSL, no Docker, no hand-installed Temporal.
- **Bring your own Temporal.** `METIS_TEMPORAL_ADDRESS=host:7233`, or a
  `temporalAddress` key in `metis.config.json`, points Metis at a Temporal you
  already run and skips the download entirely. The environment wins over the
  file, so one command can override a committed value. Omitted stays the
  default and means "manage one for me", so no existing install changes. This
  is also the escape hatch for any platform Metis ships no dev-server binary
  for. When the address is unreachable the error names the setting that asked
  for it rather than reporting a bare connection failure about a server you did
  not configure here.
- **`npm run dev`** starts the editor on 4180 and the API on 4181 together,
  with no Temporal and no Docker, on any platform. The harness already existed
  and was reachable only through Playwright. Runs are stubbed on that loop, so
  it is for editor work; use `metis up` for engine work.
- **A `windows-latest` CI job** that downloads and boots Temporal, because
  every job ran on Ubuntu and nothing had ever proved the Windows claim.

### Known limitations

- **File modes are not applied on Windows.** The credential vault key is
  written `0600`, but Node implements only the read-only bit of `chmod` there,
  so on Windows the key and vault inherit the directory's permissions. The
  encryption is unaffected; the file-permission layer underneath it is missing.
  See SECURITY.md.
- **The dev server is stopped with SIGTERM**, which Windows translates to
  TerminateProcess, so the graceful five-second window is meaningless there and
  Temporal's SQLite history can be left mid-write. Ctrl+C still works.

### Fixed

- **`metis up` no longer advertises a Temporal Web UI it does not own** when it
  is attached to an external Temporal.
- The README said three ports must be free. That is wrong for the compose path,
  which never publishes 7233, and it still told the reader to move 7233 because
  the dev server would otherwise silently attach to a stranger's Temporal -
  behaviour that ended when the port-clash guard landed.

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
