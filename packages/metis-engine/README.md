# @mindlynx/metis-engine

The Temporal worker. `helixWorkflow` walks a definition as a one-shot DAG (waves, fan-in joins, orphan cascades); inline control nodes (switch, logic, loop, filter, merge, ...) evaluate in the dispatch activity; the Loop node runs its body as real Temporal child workflows. Activities are the only substrate access, keeping workflow code deterministic.

See [docs/architecture.md](../../docs/architecture.md) for how the packages fit together.
