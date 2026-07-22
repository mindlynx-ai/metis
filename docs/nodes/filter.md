# Filter

> Split an array's elements into Kept and Discarded by conditions; an empty side's branch does not run.

## What it is
Split an array's ELEMENTS into Kept and Discarded by conditions.

## How it works
Point `Items` at an array; each element is tested against every condition (AND). `field` is a dot-path INTO the element (`status`, `customer.tier`). Kept elements flow out the Kept handle as `{{...data.kept}}`, the rest out Discarded. A side with zero elements is orphaned - its branch simply does not run.

## Gotchas
- Same 15 operators as Switch.
- This filters items INSIDE one payload; to gate the whole run, use Logic or Switch.

## Configuration reference

- `items` (required) - A reference to the array to filter, e.g. {{step.data.rows}}.
- `conditions` - Every condition must hold for an element to be kept.

## Output fields

- `kept`
- `discarded`
- `keptCount`
- `discardedCount`
