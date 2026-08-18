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
- The vault (`.metis/credentials.enc`) is AES-256-GCM with a fresh IV per
  write, and is published by an atomic rename so a crash mid-write cannot
  truncate it. Know the bound of that guarantee: the 32-byte key lives in
  `.metis/credential.key`, mode `0600`, **in the same directory as the
  ciphertext**. This protects a vault file carried off on its own; it does not
  protect against anything that can read that directory.
- **On Windows that `0600` is not applied.** Node implements only the
  read-only bit of `chmod` there, so the mode argument is silently ignored and
  the key and vault inherit whatever the containing directory grants - on a
  default user profile, readable by administrators and by any process running
  as you. The encryption is unaffected; what is missing is the file-permission
  layer underneath it. Until Metis sets a Windows ACL, put the project
  directory somewhere only you can read, and treat a shared or roaming profile
  as unsuitable for a vault.
- Node handlers resolve credentials server-side at dispatch time; secret
  values are substituted at the credential boundary and never enter workflow
  history or logs.
- `{{secrets.*}}` tokens pass through the engine untouched and resolve only
  in the dispatch activity.

## Deployment defaults

- **Metis refuses to serve on the published default admin secret.** The
  built-in value is `metis` and it is printed in this repository, so it is not
  a secret. `METIS_ADMIN_SECRET` must be set to something else or the process
  exits non-zero *before it binds a port*. This is unconditional - there is no
  environment, and no value of `METIS_ENV`, in which the default is quietly
  accepted. The single opt-out is `METIS_INSECURE_DEMO=true`, which must be
  exactly that string. Enforced by `assertServableSecret`
  (`packages/metis-cli/src/seed-users.ts`), called from `cli.ts` before
  `metis up` does anything and from `compose-entry.ts` at import time.
- **Metis listens on `127.0.0.1` by default.** Serving other machines is the
  deliberate `METIS_HOST=0.0.0.0`, which also prints a warning. In a container
  the process binds `0.0.0.0` - it has to, or a published port could not reach
  it - and the compose file pins both published ports to `127.0.0.1` instead.
  The shipped compose stack sets `METIS_INSECURE_DEMO=true` because it is a
  throwaway local stack; that is safe only because of those loopback pins.
- The compose production overlay (`compose/docker-compose.prod.yml` +
  `compose/.env.example`) documents the required variables.
- Workflow definitions are validated at start time. The code node runs in a
  fresh V8 isolate per execution (`isolated-vm`): 32 MB, a 5 s default timeout
  capped at 30 s, and no network or filesystem access - by absence rather than
  by a blocklist, since nothing that could open a socket is bridged into the
  isolate.
- Author-supplied outbound URLs are checked against private and link-local
  ranges, on every DNS record and again at every redirect hop. Every outbound
  call carries a deadline.
- The data-resource routes require `edit`. `POST /api/data/validate` plans and
  evaluates author-supplied SQL through stored credentials; `view` would have
  been no guard, because every signed-in role has it.

## Scope notes

- The webhook trigger endpoint carries no session (it is the workflow's public
  front door). It is not unverified, though: by default a delivery must carry
  an HMAC-SHA256 signature over the raw body, and GitHub's
  `x-hub-signature-256` and standard-webhooks (with a 300-second replay window)
  are the other two schemes. All are compared in constant time, and a trigger
  configured with a scheme but no stored secret fails closed. A trigger may
  also be created with `verification: "none"`, and that one genuinely is a bare
  capability URL - anyone who learns the path can start the workflow.
- Metis itself is single-tenant per deployment in the open edition.
- The Temporal dev server `metis up` manages is a **development** server:
  no TLS, no authentication, bound to loopback. That is appropriate for the
  laptop it is built for and inappropriate for anything else. A deployment that
  needs an authenticated or mTLS Temporal should run its own and point Metis at
  it with `METIS_TEMPORAL_ADDRESS`; note that the address is all Metis reads
  today, so a server requiring client certificates is not yet reachable.
