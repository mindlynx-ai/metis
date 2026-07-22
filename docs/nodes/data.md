# Data

> Read or write any data source: a SQL query or a visual table builder.

## What it is
Read or write ANY data source through one node: write SQL or build a query visually.

## How it works
Pick a connection (the connection IS the engine - Postgres in the open edition). Then either write SQL (Validate checks it against the live database and publishes the result columns as downstream variables like `{{step.data.row.email}}`) or Build a query: pick a real table, an operation (select/insert/update/delete) and filters - no SQL needed.

## Output
`rows` (capped ~1,000 rows / 256 KB so results fit through the workflow), `rowCount`, `truncated`, and `row` (the first record, for single-record references). Or set Output to **reference** to hand downstream a small dataset handle instead of rows - a later Data step opens it with "Open a dataset".

## Gotchas
- Use $1, $2 parameter placeholders in SQL; values never concatenate into the query.
- Big results truncate at the cap - larger data belongs in a warehouse engine (Helix edition).

## Configuration reference

- `connectorId` - The data source connection to run against.
- `query` - A SQL query, or build one visually. Its rows become this step's output. Use $1, $2 for parameter values.
- `output` - Rows: the result set, inline (capped). Reference: a small handle a later step can open on demand - it never hits the payload limit and is how big data flows on Tachyon.
- `sourceRef` - Materialise a dataset an earlier step handed on. Reference its dataset output, e.g. {{step.data.dataset}}.

## Output fields

- `rows`
- `rowCount`
- `totalRows`
- `truncated`
- `dataset`
