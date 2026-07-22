# API Start

> Declarative API trigger. Config-only - never executed.

## What it is
The start of a synchronous API workflow: callers POST to `/api/apiworkflow/<path>` and WAIT for the response your graph builds.

## How it works
Config-only. The request body becomes this node's output (`{{node-<id>.data.<field>}}`); the run executes synchronously and the API End node shapes the HTTP response.

## Gotchas
- An api graph must start here and contain exactly one API End.
- Synchronous means bounded: long work belongs in a normal workflow, not an api one (loops are not allowed here).

## Configuration reference

- `path` - The URL this workflow answers on, e.g. "orders" -> POST /api/apiworkflow/orders.
- `method` - The HTTP method the endpoint accepts.
