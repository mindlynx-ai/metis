# @mindlynx/metis-catalogue

Node types and connectors as DATA. `nodeTypes.v1.json` carries each node's config/output schemas, palette entry and Guide docs; the connector registry carries service definitions, credential schemas and operations. The editor renders from this; the engine validates against it; `scripts/generate-node-docs.mjs` emits the node reference from it.

See [docs/architecture.md](../../docs/architecture.md) for how the packages fit together.
