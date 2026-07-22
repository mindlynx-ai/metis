# Loop

> Iterate over items: each batch runs the 'Each item' branch as a real Temporal child workflow; 'Done' continues with the collected results.

## What it is
Iterate over items: run the `Each item` branch once per batch, then continue down `Done`.

## How it works
Point `Items` at an array (`{{step.data.rows}}`). Each batch runs the Each-item subgraph as a REAL Temporal child workflow with its own run id (`<run>-loop-<node>-<i>`) - visible in the runs list and Temporal UI. Inside the body, reference `{{node-<loopId>.data.item}}` (the current item), `.items` (the batch) and `.index`. After the last iteration the Done branch runs with `{{...data.iterations}}`, `.results` (collected leaf outputs, capped) and `.lastResult`.

## Config
`items` (the array reference), `batchSize` (default 1), `maxIterations` (default 1000 - the run fails BEFORE starting if the items need more).

## Gotchas
- Sequential and fail-fast: a failing iteration fails the run and spawns nothing further.
- Do not wire the body back to the loop (no back-edges; cycles are rejected at start).
- Body steps can still reference outside-loop steps - their outputs are carried in.

## Configuration reference

- `items` (required) - A reference to the array to iterate, e.g. {{step.data.rows}}. Each batch runs the 'Each item' branch as its own child workflow.
- `batchSize` - How many items each iteration receives ({{loop.data.items}} carries the batch; {{loop.data.item}} is the first).
- `maxIterations` - Safety cap. The run fails before starting if the items need more iterations than this.

## Output fields

- `item`
- `items`
- `index`
- `iterations`
- `results`
- `lastResult`
