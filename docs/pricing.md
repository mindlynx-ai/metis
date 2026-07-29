# Pricing

Metis is open source under Apache-2.0. Run it yourself, forever, for nothing.

## Open

**Free.** Everything in this repository.

The workflow engine, the editor, the node catalogue, webhooks and schedules,
the connector library, and durable execution on Temporal. No seat limits, no
run limits, no expiry, no phoning home. Clone it and go.

This is not a trial of something else. It is the product.

## Pro

**£9 per month, per instance.**

!!! note "Pro is not self-serve yet"

    The price is set and the first capability is built, but there is no
    checkout and no hosted paid runtime to run it on. Nobody can be charged
    today, and nobody should expect Approvals to execute on an Open build: it
    appears in the palette as a locked step and refuses with an upgrade
    message. If you want it, open an issue and say so, and that will decide
    how soon the runtime follows.

Everything in Open, plus the capabilities that need a hosted service behind
them. Today that means:

| Capability | What it does | State |
|---|---|---|
| Approvals | Pauses a run for a human decision, with a timeout branch for escalation and a record of who decided what, when and why | Built, awaiting a paid runtime |

More capabilities join Pro as they ship. They are listed in the app under
**Account**, each marked available or coming soon, so what you are paying for
is never a mystery.

### Coming to Pro

Named here so the roadmap is legible, not to imply a date:

- **Big data**: query millions of rows and run heavy transforms in the cloud
- **Memory**: give workflows long-term recall
- **Agents**: delegate steps to autonomous skills
- **Models**: managed AI models with spending caps

## What "available" means in the app

The **Account** page marks a capability `available` when it can be *bought*,
which is not the same as your instance being *entitled* to it. Entitlement is
resolved from your account, so an unpaid instance sees the price and the link,
never the capability. Nothing on this page or in that manifest can switch a
paid feature on.

## What happens if you stop paying

Your workflows are yours. They are definitions in your own instance, not
records in ours. A Pro capability stops executing and the node reports that it
needs a plan that includes it, in the same structured way it does on the Open
build. Nothing is deleted and nothing is held hostage.

## Self-hosting Pro

Pro capabilities are gated on an entitlement resolved from your account, not on
a licence key baked into the binary. The Open build physically omits the paid
packages, which is enforced by a test, so an Open build cannot be argued into
running them by configuration.

## Questions

Open an issue at
[github.com/mindlynx-ai/metis](https://github.com/mindlynx-ai/metis/issues).
