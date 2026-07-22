# Switch

> Evaluate conditions and route to a selected branch.

## What it is
Multi-way branching on a value from an earlier step - "route big orders here, the rest there".

## How it works
Branches are evaluated top-down; the first branch whose conditions ALL hold wins, and only that branch's edge runs. Everything else is orphaned (skipped, not failed). No branch matching means the Otherwise (default) handle runs. The value to check is usually a reference like `{{step.data.row.amount}}`.

## Config
Name each branch and add conditions (15 operators: equals, greater than, contains, is in list, is between, is null...). The value input adapts to the operator.

## Gotchas
- Branch handles are stable: renaming a branch keeps its edge.
- Switch tests STEP OUTPUTS (`{{...}}` references). To branch on the run's trigger input, use Logic.

## Configuration reference

- `switchOptions` - Name each branch and say when it is taken. Anything matching none takes the Otherwise path.

## Output fields

- `selectedTargetIds`
- `orphanedTargetIds`
