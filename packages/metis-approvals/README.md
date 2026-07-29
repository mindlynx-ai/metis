# @mindlynx/metis-approvals

The Approval node: a human sign-off gate inside a run. The step parks the run on a decision signal (the engine's durable wait, so nothing is consumed while it waits), takes the Approved or Rejected branch when someone decides, and records who decided, what they decided, why and when onto the run's log. An SLA that runs out never means approved.

Paid edition (`metis.edition: helix`): the open build ships the catalogue entry but no handler, so an approval step there answers with the structured upgrade response and nothing below it runs.

See [docs/architecture.md](../../docs/architecture.md) for how the packages fit together.
