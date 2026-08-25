# Code

> Run a snippet of JavaScript, TypeScript or Python.

## What it is
Run a snippet of code - the escape hatch when no other step fits. JavaScript and TypeScript run in a sandbox; Python runs on the machine and is off by default.

## How it works
Your code must `return` a value (Python: `print` a JSON value as its last line); that value becomes the step's output for downstream references. Whatever you wire into "Data in" arrives as `input`. `{{...}}` references in the code string are substituted before it runs.

## Languages
- **TypeScript** (the default) - types are stripped and the result runs in the sandbox. Type annotations only: a `const enum` or a decorator needs real compilation and is refused with a message saying so.
- **JavaScript** - the same sandbox, no stripping step.
- **Python** - a real interpreter, and **NOT sandboxed**. See the gotcha below.

## Gotchas
- JavaScript and TypeScript have no network or filesystem access - transform data, don't fetch it (use the HTTP/API node to fetch).
- **Python is not sandboxed.** It runs as whoever runs Metis, with that user's files and network, and is refused entirely unless an operator sets `METIS_PYTHON`. Only the step's timeout applies, enforced by killing the process. Treat authoring a Python step as equivalent to handing out a shell.
- `Date.now` and `Math.random` are denied in the JavaScript sandbox so a replayed run behaves the same way.
- Keep returns small; outputs ride the workflow state.

## Configuration reference

- `inputData` - The data this step transforms. Reference an earlier step, e.g. {{step.data.rows}} for a database read. It arrives in your code as `input`. Leave empty for a step that needs no input.
- `code` (required) - The code this step runs. Whatever you wire into "Data in" arrives as `input`. JavaScript and TypeScript must `return` the shape you want to pass on; Python must `print` a JSON value as its last line.
- `language` (required) - TypeScript (the default) and JavaScript run in a sandbox with no disk and no network. Python runs a real interpreter that has BOTH, and only works if your operator has enabled it - choose it only for code you would be happy to run on this machine yourself.
- `timeout` - Execution timeout in milliseconds.
- `script` - DEPRECATED: use `code` instead. Backward-compatible alias for existing workflows.

## Output fields

- `status`
- `data`
