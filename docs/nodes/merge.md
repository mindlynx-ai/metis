# Merge

> Join branches back together: waits for every incoming branch, then combines the live outputs (append, combine or pick).

## What it is
The join that brings branches back together.

## How it works
The engine already waits for every incoming branch (fan-in). Merge makes the joined DATA explicit, combining the live branches' outputs by mode:
- **append** - `{ items: [outputA, outputB, ...], count }` in edge order
- **combine** - one object, shallow-merged, later branches win shared keys
- **pick** - the first live branch's output, unchanged

## Gotchas
- Orphaned branches (a switch's losers) are excluded automatically.
- Reference the result as `{{merge.data.items}}` (append) or the merged fields directly (combine/pick).

## Configuration reference

- `mode` - Append: an items array of every branch's output. Combine: shallow-merge the outputs into one object (later branches win). Pick: the first live branch's output.

## Output fields

- `items`
- `count`
