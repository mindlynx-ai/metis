# The Metis MCP server

`metis mcp` serves the Model Context Protocol over stdio, so AI tools (Claude
Code, Claude Desktop, anything MCP-capable) can build and run workflows
against a RUNNING Metis instance. It is a thin client of the HTTP control
plane - point it at `metis up`, docker compose, or a remote deployment.

## Setup

```json
{
  "mcpServers": {
    "metis": {
      "command": "npx",
      "args": ["@mindlynx/metis-cli", "mcp"],
      "env": { "METIS_URL": "http://localhost:3000" }
    }
  }
}
```

Auth: set `METIS_TOKEN`, or `METIS_USER`/`METIS_SECRET` (defaults to the
local dev seed `admin`/`metis`). The server logs in lazily and re-logs-in on
401, and never writes anything except protocol frames to stdout.

## Tools

| Tool | What it does |
|---|---|
| `list_node_types` | Browse the node catalogue (searchable) |
| `get_node_type` | One type's config/output schema, long-form docs, and the branch handle ids its edges must use |
| `list_connections` | The saved connections (metadata only) - a connector node's `config.connectorId` points at one |
| `list_workflows` / `get_workflow` | Read what exists |
| `validate_workflow` | Dry-check a graph (start node, cycles, loop/branch rules) without saving |
| `create_workflow` / `update_workflow` | Save a definition (nodes + edges; the tool descriptions carry the exact shape) |
| `publish_workflow` | Make the current draft the live version a trigger can fire |
| `delete_workflow` | Soft-delete a workflow |
| `run_workflow` | Start a run and wait briefly; returns per-step outcomes |
| `get_execution` | A run's status + per-step outputs (loop children by their own execution id) |
| `list_executions` | Recent runs from Temporal visibility, filterable by status |
| `manage_execution` | Operate a run: cancel / terminate / reset |
| `create_trigger` | Bind a webhook / schedule / poll trigger so a published workflow fires on its own |
| `list_triggers` / `delete_trigger` | See and remove triggers |
| `manage_schedule` | Pause or resume a workflow's schedule |

The catalogue tools return the same Guide documentation the inspector shows
humans - so the model knows what a node is, how it works and how to wire its
branches before it builds.

## The full lifecycle

The tools cover a workflow end to end: browse node types and connections,
validate a graph, create it, publish it, bind a trigger (webhook or cron),
run it, and operate or reset the runs - all without leaving the AI tool.
Building a *connector* workflow (SendGrid, Postgres) needs a connection first;
`list_connections` shows the ids, but connections are created in the Metis UI
so credentials never pass through the model.
