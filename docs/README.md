# Metis documentation

Metis is an open-source workflow engine: draw a flow of steps, run it, and
watch every step as it happens. Durable by [Temporal](https://temporal.io),
Apache-2.0, runs entirely on your machine.

New here? Start with the [project README](https://github.com/mindlynx-ai/metis#readme)
for the two quickstarts (Docker and the CLI), then come back for the deeper guides.

## Guides

- [Architecture](architecture.md) - the package map, the data flow, and the
  invariants that hold the system together.
- [Adding a node](adding-a-node.md) - how a new node type goes from catalogue
  entry to running handler.
- [Connectors](connectors.md) - the data-driven integration model: definitions,
  credentials, and the operation catalogue.
- [Running tests](running-tests.md) - the unit suites, the real-Temporal e2e
  suites, and the six release gates.
- [AI tools (MCP)](mcp.md) - let Claude and other MCP-capable tools browse the
  catalogue, build workflows and run them.

## Node reference

Every built-in node type, generated from the catalogue that also powers the
editor's palette and inspector Guide tab:

- [Node reference index](nodes/README.md)

## The project

- [Source on GitHub](https://github.com/mindlynx-ai/metis)
- [Contributing](https://github.com/mindlynx-ai/metis/blob/main/CONTRIBUTING.md)
- [Security policy](https://github.com/mindlynx-ai/metis/blob/main/SECURITY.md)
- [Changelog](https://github.com/mindlynx-ai/metis/blob/main/CHANGELOG.md)
- Metis Cloud: [metisflow.io](https://metisflow.io)
