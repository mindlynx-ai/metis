# @mindlynx/metis-ports

The seams everything else plugs into: NodeExecPort, CredentialPort, DataSourcePort, ExecutionPort, EventSink, IdentityPort - plus in-memory fakes for tests. Ports depend on nothing; every other package depends on ports. If you are adding an integration point, it starts here.

See [docs/architecture.md](../../docs/architecture.md) for how the packages fit together.
