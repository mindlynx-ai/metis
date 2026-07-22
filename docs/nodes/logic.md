# Logic

> Branch on a predicate tree (AND/OR/NOT with leaf conditions).

## What it is
A yes/no gate on the workflow's trigger input: an AND/OR/NOT rule tree routes to the Yes or No branch.

## How it works
The rule tests the run's INPUT (what the trigger received) via `ctx.input.<field>` paths. Groups combine children with AND / OR / NOT; nest groups for complex rules. Yes runs when the tree holds; No otherwise; the losing branch is orphaned.

## Gotchas
- `ctx.input.` paths only - a `{{step.data...}}` reference will not resolve here. To branch on a step's output, use Switch.
- A missing field is falsy, never an error.

## Configuration reference

- `predicate` - Build a rule from conditions grouped with AND / OR / NOT.

## Output fields

- `branchTaken`
- `selectedTargetIds`
- `orphanedTargetIds`
