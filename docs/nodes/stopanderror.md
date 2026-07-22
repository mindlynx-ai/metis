# Stop and Error

> Halt the workflow on purpose and fail the run with your message. A guard for states that should never continue.

## What it is
An intentional kill switch: fail the run, loudly, with your message.

## How it works
The run stops here and is marked failed with the configured message (template-resolvable, e.g. `Rejected: {{step.data.row.reason}}`). Wire it behind a Switch/Logic branch as a guard for states that must never continue.

## Gotchas
- Terminal: it has no output handle.
- The message is the run's failure reason - make it say WHY.

## Configuration reference

- `message` (required) - The run fails with this message. Reference upstream values, e.g. Rejected: {{step.data.row.reason}}.
