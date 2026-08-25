# Code

> Run a snippet of JavaScript or Python.

## What it is
Run a snippet of code - the escape hatch when no other step fits. JavaScript runs in a sandbox; Python runs on the machine and is off by default.

## How it works
Your code must `return` a value (Python: `print` a JSON value as its last line); that value becomes the step's output for downstream references. Whatever you wire into "Data in" arrives as `input`, and with nothing wired it is the run's own input - which is what the Test panel's sample input feeds. `{{...}}` references in the code string are substituted before it runs.

## Languages
- **JavaScript** (the default) - a fresh V8 isolate per run, with no disk and no network.
- **Python** - a real interpreter, and **NOT sandboxed**. See the gotcha below.

TypeScript is no longer offered. Metis only ever stripped the types rather than checking them, so it gave you the syntax and none of the safety. Steps already saved as TypeScript keep running.

## Gotchas
- JavaScript has no network or filesystem access - transform data, don't fetch it (use the HTTP/API node to fetch).
- **Python is not sandboxed.** It runs as whoever runs Metis, with that user's files and network, and is refused entirely unless an operator sets `METIS_PYTHON`. Only the step's timeout applies, enforced by killing the process. Treat authoring a Python step as equivalent to handing out a shell.
- `Date.now` and `Math.random` are denied in the JavaScript sandbox so a replayed run behaves the same way.
- Keep returns small; outputs ride the workflow state.

## Configuration reference

- `inputData` - The data this step transforms. Reference an earlier step, e.g. {{step.data.rows}} for a database read. It arrives in your code as `input`. Leave empty for a step that needs no input.
- `code` (required) - The code this step runs. Whatever you wire into "Data in" arrives as `input`. JavaScript and TypeScript must `return` the shape you want to pass on; Python must `print` a JSON value as its last line.
- `language` (required) - JavaScript runs in a sandbox with no disk and no network. Python runs a real interpreter that has BOTH, and only works if your operator has enabled it - choose it only for code you would be happy to run on this machine yourself.
- `timeout` - Execution timeout in milliseconds.
- `script` - DEPRECATED: use `code` instead. Backward-compatible alias for existing workflows.

## Output fields

- `status`
- `data`
