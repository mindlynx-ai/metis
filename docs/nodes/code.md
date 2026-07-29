# Code

> Run a sandboxed JavaScript snippet.

## What it is
Run a JavaScript snippet in a sandbox - the escape hatch when no node fits.

## How it works
Your code runs sandboxed with a time limit and must `return` a value; that value becomes the step's output for downstream references. `{{...}}` references in the code string are substituted before it runs.

## Gotchas
- No network or filesystem access - transform data, don't fetch it (use the HTTP/API node to fetch).
- Keep returns small; outputs ride the workflow state.

## Configuration reference

- `inputData` - The data this step transforms. Reference an earlier step, e.g. {{step.data.rows}} for a database read. It arrives in your code as `input`. Leave empty for a step that needs no input.
- `code` (required) - JavaScript that returns this step's output. Whatever you wire into "Data in" arrives as the variable `input`; `return` the shape you want to pass on.
- `language`
- `timeout` - Execution timeout in milliseconds.
- `script` - DEPRECATED: use `code` instead. Backward-compatible alias for existing workflows.

## Output fields

- `status`
- `data`
