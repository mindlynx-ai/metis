# Connectors and credentials

A **connector** is a service definition (base URL, auth scheme, operations) -
data in the catalogue, not code. A **connection** is your named instance of
one, with your credentials. Nodes use connections, never raw secrets.

## Add a credential (a connection)

In the editor, any connector-backed step shows a **Connection** picker with
"+ New connection". The form is generated from the connector's credential
schema (an API key for most; Stripe carries three fields; Postgres asks for
host/port/database/user/password). **Test** verifies the credentials against
the live service before you save.

From the CLI/API:

```bash
curl -X POST http://localhost:3000/api/connections \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"My SendGrid","connectorId":"sendgrid","material":{"apiKey":"SG...."}}'
```

## The write-only boundary

Credential material is stored encrypted and never returned by the API:

- `GET /api/connections` returns metadata only.
- `GET /api/connections/:id` returns only NON-secret fields (to pre-fill the
  edit form); secret fields never leave the server.
- `PATCH` merges material, so rotating one field keeps the others.
- Node handlers resolve material server-side at dispatch time.

## OAuth connectors

OAuth-capable connectors offer "Connect with ..." instead of a key form:
`/api/connectors/:id/oauth/start` begins the provider flow and the callback
stores the token as connection material - same boundary, no manual copying.
Set the provider client id/secret via environment (see `compose/.env.example`).

## Databases are connections too

The Data node's engine IS its connection: create a `postgres` connection and
the node can list its tables, validate SQL against it and run queries. Other
engines appear as locked options in the open edition.

## Adding a connector definition

Connectors live in `packages/metis-catalogue/src` (the registry + credential
schemas + operations). A connector with verified operations automatically
becomes a pickable node type with typed parameter fields - no handler code.
See `docs/adding-a-node.md` for the node-type side.
