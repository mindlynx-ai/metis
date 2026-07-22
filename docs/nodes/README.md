# Node reference

Generated from the node catalogue - do not edit by hand
(run `node scripts/generate-node-docs.mjs`).

- [API Start](apiconfig.md) - Declarative API trigger. Config-only - never executed.
- [API End](apiend.md) - Declarative API response marker. Config-only - never executed.
- [Schedule](scheduleconfig.md) - Declarative cron-based schedule. Config-only - never executed.
- [Webhook Start](webhookconfig.md) - Declarative webhook trigger. Config-only - never executed.
- [Signal](signal.md) - Pause the workflow until an external signal arrives.
- [Switch](switch.md) - Evaluate conditions and route to a selected branch.
- [Logic](logic.md) - Branch on a predicate tree (AND/OR/NOT with leaf conditions).
- [Wait Until](waituntil.md) - Pause execution for a configurable duration.
- [No Operation](noop.md) - Does nothing: a junction or label to keep a flow readable. Passes the walk straight through.
- [Stop and Error](stopanderror.md) - Halt the workflow on purpose and fail the run with your message. A guard for states that should never continue.
- [Merge](merge.md) - Join branches back together: waits for every incoming branch, then combines the live outputs (append, combine or pick).
- [Loop](loop.md) - Iterate over items: each batch runs the 'Each item' branch as a real Temporal child workflow; 'Done' continues with the collected results.
- [Filter](filter.md) - Split an array's elements into Kept and Discarded by conditions; an empty side's branch does not run.
- [Compare Datasets](comparedatasets.md) - Diff two arrays keyed by match fields into In A only / Same / Different / In B only; empty branches do not run.
- [Code](code.md) - Run a sandboxed JavaScript snippet.
- [Data](data.md) - Read or write any data source: a SQL query or a visual table builder.
- [HTTP API](api.md) - Call an external HTTP API. Supports retry, configurable timeout, and headers array format.
- [SendGrid](sendgrid.md) - Send transactional email via a SendGrid connector. Supports basic to/from/subject/text/html; templates, cc/bcc and open-tracking are not yet supported.
