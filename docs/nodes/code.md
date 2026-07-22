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

- `code` (required) - JavaScript/TypeScript code. Use ctx.input to access workflow input.
- `language`
- `timeout` - Execution timeout in milliseconds.
- `script` - DEPRECATED: use `code` instead. Backward-compatible alias for existing workflows.

## Output fields

- `status`
- `data`
