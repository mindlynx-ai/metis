# Wait Until

> Pause execution for a configurable duration.

## What it is
A durable pause: continue after a delay or at a specific time.

## How it works
Temporal sleeps the run (no worker resources consumed - it survives restarts and deploys). When the timer fires the walk continues.

## Gotchas
- The wait is calculated when the node starts, not when the run starts.

## Configuration reference

- `waitDays`
- `waitHours`
- `waitMinutes`
- `waitSeconds`
- `dateFrom` - Optional absolute reference point; offsets are relative if omitted.

## Output fields

- `action`
- `durationMs`
