# Changelog

## 0.1.0 - initial open-source release

The first public release of Metis: a workflow builder for developers who want
durable execution on Temporal without writing worker code first.

- Visual builder (React Flow canvas + schema-driven inspectors) with the
  Helix-compatible workflow shape.
- Durable engine on Temporal: one-shot DAG walk, per-node policies
  (retries/backoff/timeout/continue-on-failure), signals, durable waits.
- Control-flow nodes: Switch (multi-way), Logic (AND/OR/NOT on trigger
  input), Loop (one Temporal child workflow per iteration), Filter,
  Compare Datasets, Merge, No Operation, Stop and Error, Wait Until, Signal.
- Data node: SQL or a visual query builder against pluggable data sources
  (Postgres in the open edition), live validation that publishes result
  columns as downstream variables, capped inline results and dataset
  references.
- Connectors-as-data with a bring-your-own-credentials boundary; webhook,
  schedule and API triggers; outbound webhooks; run history with live
  WebSocket updates.
- In-app node Guide docs, generated node reference, six release gates,
  full unit + e2e + system test suites.
