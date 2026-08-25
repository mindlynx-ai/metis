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

- **A real editor for every long-form field.** Code, SQL, HTTP bodies, JSON and
  connector text params were all plain textareas: no line numbers, no
  highlighting, no indentation, no bracket matching. They are now one Monaco
  widget - the editor from VS Code - with a grammar chosen per field.
  The published bundle went from 1,076,134 to 3,927,002 bytes. That is the whole
  cost, and it is far below the 15 MB the `monaco-editor` barrel produces:
  importing the barrel drags every language FEATURE and each feature's web
  worker, of which ts.worker alone is 7 MB. Metis imports the core api and four
  tokenizers, so it pays for colouring and editing and not for browser-side
  diagnostics it deliberately does not show.
- **A Validate button, and squiggles as you type.** `POST /api/code/validate`
  parses without running. It is answered by the same V8 isolate or CPython that
  will run the step, so it agrees with the runtime - unlike a checker in the
  browser, which passes `fetch(...)`, refuses top-level `return`, and has
  nothing to say about Python at all. The button answers on demand; a 700 ms
  pause in typing asks the same question and underlines the answer.
- **A workbench for code steps.** "Open the editor" gives a wide window holding
  what the step receives, the code, a sample input, Run, and what it passes on -
  the loop you are actually in, rather than the code in one tab and the result
  in another. For a code step the Test tab now points at it; every other step
  type keeps the Test tab as it was.
- **The failing line is marked in the gutter**, with the message beside it, and
  clears the moment that line is edited.

### Fixed

- **The MCP server could hang for ever on a refused token.** Its control-plane
  client retried a 401 by logging in and calling itself again, with no limit.
  That is fine while a fresh token works, and fatal when one does not - a
  rotated signing key, clock skew, an evicted session - because the recursion
  never ends: the process dies of a stack overflow, and the AI tool driving it
  simply waits. It now retries exactly once and reports the 401.
- **The MCP server said only "fetch failed" when Metis was not running.** That
  is what `fetch` throws for a refused connection, a wrong port and an
  unresolvable host alike, and it names none of them - so the commonest failure
  there is read as an unexplained dead end to the one reader who has to act on
  it. It now names the URL it tried and how to fix it.
- **An API workflow ran EVERY branch of a switch, and could answer from the one
  it did not take.** `helixApiWorkflow` hand-built its `executeNode` request
  instead of using the builder `helixWorkflow` shares, and left four things off
  it. Without `targets` a branch node selected a path and then orphaned nothing,
  so both sides of a decision ran - in a synchronous API endpoint that means
  both sides send the mail or take the payment. Without `inputData` a code step
  saw `input` as `null`, though the same step reached by a webhook received the
  payload. Merge nodes lost their sources, and per-node retry policy and cloud
  routing were ignored. Separately, API End answered from the FIRST edge drawn
  into it rather than the branch that ran, so a graph whose losing branch
  happened to be drawn first returned null. Both walkers now share one request
  builder and one branch-type set, the API walker orphans the paths a branch did
  not take (recording the same `workflow.node.orphaned` event), and API End
  answers from the source that completed.
- **The Data node's table picker kept the schema (breaking a silent wrong
  answer).** The connection reports every table as name AND schema, and the
  handler has always honoured `config.schema` - but the picker mapped the list
  down to bare names and never sent one. So two schemas each holding a table of
  one name collapsed into two identical, indistinguishable entries, and
  whichever you picked built a query against the engine's DEFAULT schema. If a
  table of that name happened to live there, the step read the wrong table and
  reported success. The picker now keeps the schema, qualifies a label only when
  the bare name is ambiguous, and records the schema on the step. The same code
  path already anticipated this: `datasetFor` deliberately hands on a raw
  qualified query rather than a bare table name whenever a schema is set.
- **Error positions point at the line you wrote.** Neither language ran your
  source on its own: JavaScript went inside an async wrapper and Python got a
  two-line preamble, and both reported positions in THAT file. Every line number
  was two out, and JavaScript spliced the code mid-line as well, so a mistake on
  line 1 column 5 was reported as `[<isolated-vm>:3:51]`. A wrong line number
  sends you to the wrong place with confidence, and it was about to matter more
  because the new gutter marks whatever these say.
- **The Python traceback no longer leaks a temp path.**
  `/var/folders/.../metis-py-KH4NRh/step.py` named a scratch file that will not
  exist by the time anybody looks.
- **A modal hands focus back when it closes**, and traps Tab while open. Closing
  used to drop focus to the document, so a keyboard user restarted from the top
  of the page.
- **The full browser suite was not attaching the run-status socket**, so every
  live update in it waited for ever. It is not in CI, so it rotted unnoticed
  after the socket moved out of `buildControlServer`.

### Changed

- **TypeScript is no longer offered on the code step**, and JavaScript is the
  default. Metis only ever STRIPPED the types rather than checking them, so it
  gave authors the syntax and none of the safety while implying otherwise - and
  it was the default. Steps already saved as TypeScript keep running exactly as
  before; the language simply cannot be chosen again.


- **Python code steps.** The catalogue has always offered `python` and the
  handler never read the `language` field, so a Python step ran as JavaScript
  until it happened to throw. Python now runs a real interpreter. **It is not
  sandboxed** - unlike JavaScript it has the machine's disk and network - so it
  is refused entirely unless an operator sets `METIS_PYTHON`. Read the code
  step's docs and SECURITY.md before enabling it.
- **TypeScript code steps.** `typescript` is the catalogue's DEFAULT and typed
  source used to fail with a V8 syntax error, which is as close to "broken out
  of the box" as a setting gets. Types are now stripped before the sandbox runs
  the code. Type annotations only: a `const enum` or a decorator needs real
  compilation and is refused with a message that says so.
- **A `.env` file.** `metis init` writes one, and Metis reads it on every
  platform. The one required setting, `METIS_ADMIN_SECRET`, was documented with
  `export`, which neither cmd.exe nor PowerShell has - so on Windows the first
  command in the README produced a refusal that read like a broken CLI. No new
  dependency: Node has read `.env` natively since 22.13, already the floor here.
- **Links can be removed.** Drawing one was always possible and undoing it was
  not: hover a link and a control appears, or select it and press Backspace.
  Previously the only way to unlink two steps was to delete one of them.
- **The theme follows your system** on a first visit instead of always starting
  dark. A theme you have chosen still wins.

### Fixed

- **The live run feed reconnects and stays connected.** Three pages each opened
  their own WebSocket, and one was rebuilt whenever a run started or a run was
  opened - so the feed died at the moment it mattered. There is now one socket
  per tab, shared, with rooms reference-counted and rejoined after any drop.
- **The WebSocket reaches both loopback addresses.** `metis up` bound
  `127.0.0.1` only while the hub was attached to a single server. Windows
  resolves `localhost` to `::1` first, so its browsers loaded the page over an
  IPv4 fallback and then failed the upgrade, which does not fall back as
  reliably. Metis now serves both loopback addresses and attaches the hub to
  every one of them. Still loopback-only.
- **A failed upgrade degrades to polling** instead of dying. The client pinned
  `transports: ['websocket']`, so any upgrade failure was terminal and silent.
- **`/ws/...` no longer answers with the editor's HTML.** The static route had
  no extension to match on, so a socket handshake got a 200 and an HTML page
  where an Engine.IO packet was expected. It 404s now, like `/api/...`.
- **The credential vault is restricted on Windows.** `chmod 0600` is a silent
  no-op there, so the vault and the key beside it inherited the folder's rights.
  Both now get an explicit ACL as they are written.
- **A missing `isolated-vm` no longer takes down the whole boot.** It was
  required at module scope, so a failed native build killed `metis up` with a
  raw node-gyp error naming nothing. It loads on first use and explains itself.
- **Testing a code step actually uses your sample input.** The inspector's Test
  tab runs one step alone with a "Sample input" box, which works for a connector
  because its config is what it sends. The code step read only its own "Data in"
  config, empty on a step nobody has wired yet - so the box changed nothing and
  testing `input.n` reported "Cannot read properties of null". A code step with
  no Data in configured now falls back to the run input, in JavaScript,
  TypeScript and Python alike. A configured Data in still wins, because that is
  the wired-up answer.
- **Publishing refuses a step that is not finished.** The catalogue has always
  declared which fields a step cannot work without, and nothing enforced it:
  `validateDefinition` checks the SHAPE of a graph and never looks inside a
  node. So a code step with no code saved without a murmur and published
  cheerfully - "your workflow is live", for a workflow that could not possibly
  run - and the only sign was a failed run once the trigger had already fired.
  Publish now names the step and the field. Presence only: it does not
  type-check values or parse anybody's code. **A workflow already published with
  a gap will refuse to re-publish until it is filled in.**
- **The code step's language is a primary field**, not something behind "Show
  advanced". It picks the execution engine, and for Python decides whether the
  step can reach the disk and the network, so it belongs in front of you. Its
  fields are properly titled, and the description no longer claims the step runs
  JavaScript now that the default is TypeScript and Python prints rather than
  returns.
- **The Reviews empty state says what it is waiting for**, rather than being
  indistinguishable from a broken page.


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
- **The `cli-e2e` CI job is green again.** Its `metis up` server check booted
  the child with a real admin secret and then tried to sign in with the
  published default, which Metis refuses to serve on. The login could never
  return 200, so the check polled for ninety seconds and failed. The job had
  been red on every run for three weeks.
- **The real download-and-boot check now exercises the real downloader.** It
  carried its own copy of the fetch-and-extract pair, so the one test that
  claims to prove the download proved a parallel implementation instead. That
  copy hardcoded `/usr/bin/tar` and an extensionless binary name and could only
  ever pass on POSIX.
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
