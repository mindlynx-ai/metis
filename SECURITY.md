# Security

## Reporting a vulnerability

Email **security@seillen.com** with a description and reproduction steps.
Please do not open a public issue for security reports. We aim to acknowledge
within 48 hours.

## The credential boundary

Metis stores third-party connector credentials, so the boundary matters:

- Credentials are **write-only through the API**: material is stored encrypted
  and is never returned to a client. The connection endpoints return metadata
  only; secret-flagged fields never leave the server (non-secret values are
  returned solely to pre-fill the edit form).
- Node handlers resolve credentials server-side at dispatch time; secret
  values are substituted at the credential boundary and never enter workflow
  history or logs.
- `{{secrets.*}}` tokens pass through the engine untouched and resolve only
  in the dispatch activity.

## Deployment defaults

- The local dev seed uses the admin secret `metis` for a zero-friction first
  run. **Production refuses to boot with it**: when `METIS_ENV=production`,
  a non-default `METIS_ADMIN_SECRET` is required
  (`packages/metis-cli/src/seed-users.ts`).
- The compose production overlay (`compose/docker-compose.prod.yml` +
  `compose/.env.example`) documents the required variables.
- Workflow definitions are validated at start time; the code node runs
  sandboxed with a time limit and no network or filesystem access.

## Scope notes

- The webhook trigger endpoint is unauthenticated by design (it is the
  workflow's public front door); treat its path as a capability URL.
- Metis itself is single-tenant per deployment in the open edition.
