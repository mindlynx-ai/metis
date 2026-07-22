# Signal

> Pause the workflow until an external signal arrives.

## What it is
Wait for the outside world: the run parks until a named signal arrives (or a timeout).

## How it works
The run pauses durably (a Temporal condition - no compute burned while waiting). An external system resumes it by signalling the execution with a matching `signalType`; the signal's params become this node's output.

## Gotchas
- Default timeout is 24h; a timeout fails the run.
- Signal names are matched case-insensitively.

## Configuration reference

- `signalType` (required) - External signal name (e.g. 'adobesign.signed'). Matched against incoming helixSignal payloads.
- `timeoutMs` - Max wait in ms. Default 24h.

## Output fields

- `action`
- `signalType`
