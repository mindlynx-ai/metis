# HTTP API

> Call an external HTTP API. Supports retry, configurable timeout, and headers array format.

## What it is
Call any HTTP API: method, URL, headers, body.

## How it works
Configure the request; `{{...}}` references work in the URL, headers and body. The response (status, headers, parsed body) becomes the step's output. A 4xx/5xx completes the step but is surfaced as an error in the Test tab - check `status`/`ok` downstream if you branch on it.

## Gotchas
- Secrets belong in a connection, not pasted into headers.

## Configuration reference

- `url` (required)
- `method` (required)
- `headers`
- `body`
- `auth`
- `timeout`
- `retries`
- `retryDelay`

## Output fields

- `status`
- `data`
