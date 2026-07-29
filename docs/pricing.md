# Pricing

Metis is open source under Apache-2.0. Run it yourself, forever, for nothing.

The line is simple: **you pay for work that runs somewhere else.** Anything that
runs on the machine in front of you is in the download, and no plan is needed to
use it.

## Open

**Free.** Everything in this repository.

The workflow engine, the editor, every node type in the catalogue, webhooks and
schedules, the connector library, and durable execution on Temporal. No seat
limits, no run limits, no expiry, no phoning home. Clone it and go.

That deliberately includes two things a lot of tools charge for:

- **The sign-off gate.** A run can stop and wait for a person, with a role
  floor, an SLA, an escalation branch and a rejection that has to carry a
  reason. A run that waits for a human is something a workflow engine has to
  have. Selling it back to the person who needs it is the wrong trade.
- **The audit log.** Who did what, when, and whether it was allowed. A record of
  who approved a refund is not a feature to sell to the person being audited.

This is not a trial of something else. It is the product.

## Cloud

**£9 per month.** Metis, hosted and operated for you at
[app.metisflow.io](https://app.metisflow.io) - plus the one capability that
genuinely cannot run on your own machine.

| Capability | What it does | State |
|---|---|---|
| Big data | Query millions of rows and run heavy transforms on a warehouse we operate. The step is in the Open build and runs locally against your own database; the cloud backend is what the plan unlocks | Built, awaiting checkout |

!!! note "There is no checkout yet"

    The price is set and the capability is built on both sides, but you cannot
    buy it today and nobody has been charged. Until that changes, treat this
    page as a statement of intent rather than an offer. If you want it, open an
    issue and say so - that is what decides how soon it follows.

### Coming to Cloud

Named so the roadmap is legible, not to imply a date:

- **Memory**: give workflows long-term recall
- **Agents**: delegate steps to autonomous skills
- **Models**: managed AI models with spending caps

## Enterprise

For running one Metis across an organisation. Not built yet, and named here
rather than hinted at:

- **Multi-tenancy**: one instance serving many separate organisations, sealed
  off from each other
- **Teams and sign-on**: a real user directory with invites and single sign-on,
  instead of the handful of accounts a self-hosted instance seeds from its
  environment

A download runs one tenant and a small number of users. That is the right shape
for the people who run it themselves, and it is an honest description rather
than a crippled one.

## What "available" means in the app

The **Account** page marks a capability `available` when it can be *bought*,
which is not the same as your instance being *entitled* to it. Entitlement is
resolved from your account, so an unpaid instance sees the price and the link,
never the capability. Nothing on this page or in that manifest can switch a paid
feature on.

## What happens if you stop paying

Your workflows are yours. They are definitions in your own instance, not records
in ours. A cloud capability stops executing and the step says it needs a plan
that includes it, in the same structured way it does on a fresh Open build - the
definition stays valid and nothing is deleted.

For **Big data** specifically, the step keeps working: it runs against your own
database locally, as it does in the Open build. What you lose is the warehouse
behind it, not the node.

## Self-hosting

Cloud capabilities are gated on an entitlement resolved from your account, not
on a licence key baked into the binary, and not on which build you downloaded.
An Open build cannot be argued into running a hosted capability by
configuration, because the work happens on a server it has no account with.

## Questions

Open an issue at
[github.com/mindlynx-ai/metis](https://github.com/mindlynx-ai/metis/issues).
