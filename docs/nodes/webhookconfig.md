# Webhook Start

> Declarative webhook trigger. Config-only - never executed.

## What it is
The workflow's front door: an HTTP endpoint that starts a run whenever something POSTs to it.

## How it works
Config-only - it never executes. Publishing the workflow registers the endpoint; each delivery becomes a run, and the request lands as this node's output: reference it downstream as `{{node-<id>.data.body.<field>}}` (the envelope carries `body`, headers and metadata).

## Gotchas
- A published workflow must start with a trigger (this, Schedule or Signal).
- Paste a sample payload in the inspector ("declare outputs") so downstream steps can pick fields before the first real delivery.

## Can the sender actually reach it?
This is the question people hit first, and it is not about Metis.

`metis up` listens on `localhost`, which means THIS MACHINE and nothing else. Every computer calls itself `localhost`, so a provider on the internet - Stripe, GitHub, anything - has no way to mean yours. The trigger arms, the URL looks right, and the delivery never arrives.

To take real deliveries, put a public address in front of Metis:
- **A tunnel**, for testing: `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Both hand you a public https address; use it in place of `http://localhost:3000` when you paste the webhook URL into the provider.
- **A host with its own address**, for anything lasting. Set `METIS_HOST=0.0.0.0` so Metis serves more than loopback, and put it behind TLS.

Binding a webhook trigger returns the full URL and says which of these you are looking at. Anything on the same machine or the same network can already call it as it stands: `curl -X POST http://localhost:3000/hooks/<triggerId> -d '{}'`.

## Verifying the sender
An endpoint that starts a run is worth protecting: it is deliberately unauthenticated, so anyone who can reach the URL can start runs. Bind the trigger with a `verification` scheme (`github`, `svix` or `hmac`) and a shared secret, and an unsigned, forged or tampered delivery is refused 401.

## Configuration reference

- `triggerType`
- `path`
