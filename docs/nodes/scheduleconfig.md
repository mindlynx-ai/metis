# Schedule

> Declarative cron-based schedule. Config-only - never executed.

## What it is
A cron trigger: the workflow runs on a schedule (backed by a real Temporal Schedule).

## How it works
Config-only - publishing creates the Temporal schedule from your cron expression and timezone; each firing starts a run. The run input is empty; the schedule's metadata is available on the trigger node's output.

## Gotchas
- Cron is standard 5-field syntax (`*/5 * * * *` = every 5 minutes).
- Pausing/removing happens when you unpublish or delete the workflow.

## Configuration reference

- `cron`
- `timezone`
