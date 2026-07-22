# Webhook Start

> Declarative webhook trigger. Config-only - never executed.

## What it is
The workflow's front door: an HTTP endpoint that starts a run whenever something POSTs to it.

## How it works
Config-only - it never executes. Publishing the workflow registers the endpoint; each delivery becomes a run, and the request lands as this node's output: reference it downstream as `{{node-<id>.data.body.<field>}}` (the envelope carries `body`, headers and metadata).

## Gotchas
- A published workflow must start with a trigger (this, Schedule or Signal).
- Paste a sample payload in the inspector ("declare outputs") so downstream steps can pick fields before the first real delivery.

## Configuration reference

- `triggerType`
- `path`
