# SendGrid

> Send transactional email via a SendGrid connector. Supports basic to/from/subject/text/html; templates, cc/bcc and open-tracking are not yet supported.

## What it is
Send transactional email via a SendGrid connection.

## How it works
Pick your SendGrid connection, set from/to/subject/body; `{{...}}` references personalise any field. The response (message id) is the step's output.

## Gotchas
- The from address must be verified in SendGrid.
- Templates, cc/bcc and open-tracking are not yet supported.

## Configuration reference

- `connectorId` (required) - Id of a `sendgrid_api_key` connector.
- `type`
- `templateId` - Dynamic template id when type=template.
- `substitutions` - Template variable substitutions.
- `to` (required)
- `cc`
- `bcc`
- `from` (required)
- `subject` (required)
- `body`
- `fieldMapping`

## Output fields

- `status`
- `data`
