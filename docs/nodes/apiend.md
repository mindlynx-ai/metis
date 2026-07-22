# API End

> Declarative API response marker. Config-only - never executed.

## What it is
The API workflow's response: what the HTTP caller gets back.

## How it works
Pass a node's output through unchanged (`sourcedata`), or build a mapped JSON object with `{{node-id.data.field}}` references (`mappeddata`). Set the status code (default 200).

## Gotchas
- Exactly one API End per api graph.
- If the run fails before reaching it, the caller gets the failure instead.

## Configuration reference

- `responseType` - Pass through a node's output, or build a mapped JSON object.
- `responseNodeId` - Which node's output to return (pass-through). Defaults to the node wired into API End.
- `responseMapping` - A JSON object; use {{node-id.data.field}} to pull values from the run.
- `statusCode` - The HTTP status to return.
