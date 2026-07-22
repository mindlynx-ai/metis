# Compare Datasets

> Diff two arrays keyed by match fields into In A only / Same / Different / In B only; empty branches do not run.

## What it is
Diff two arrays: what's only in A, what's the same, what changed, what's only in B.

## How it works
Point Input A and Input B at two array references and name the match fields (comma-separated keys that identify the same record in both, e.g. `email`). Records pair up by key; paired records with identical remaining fields go to Same, otherwise Different (carrying both versions as `{a, b}`). Unpaired records go to In A only / In B only. Empty sides are orphaned.

## Gotchas
- Wire both source steps into this node so their data exists before it runs.
- Field-order differences do not count as Different (canonical comparison).

## Configuration reference

- `itemsA` (required) - A reference to the first array, e.g. {{stepA.data.rows}}.
- `itemsB` (required) - A reference to the second array, e.g. {{stepB.data.rows}}.
- `matchFields` (required) - Comma-separated keys that identify the same record in both inputs, e.g. email or id, region.

## Output fields

- `aOnly`
- `same`
- `different`
- `bOnly`
- `counts`
