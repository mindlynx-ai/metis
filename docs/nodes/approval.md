# Approval

> Park the run until a person signs off, then take the approved or rejected branch.

## What it is
A human sign-off gate inside a run: the run parks, someone reviews it, and the Approved or Rejected branch runs.

## How it works
When the step is reached the approval is raised with the values you chose to show, and the run parks durably (no compute is used while it waits, and it survives restarts). The reviewer decides in Reviews; their identity comes from their session, never from the request, so the run's log answers 'who approved this'. The decision, the reason and the time are recorded on the run.

## Config
**What is being approved** and **Show the reviewer** are what a reviewer sees, so put the numbers that decide it there (amount, customer, reason). **Who may approve** is the lowest role allowed to decide, admin by default. **Decide within** sets the SLA and **If nobody decides** what happens when it runs out.

## Gotchas
- Nothing runs below an approval until it is decided: wire the Rejected branch, or a rejection simply ends that path.
- Expiry never means approved. The safest it gets is Reject.
- A viewer cannot approve at all, whatever the role says.

## Configuration reference

- `title` (required) - The one line a reviewer reads first, e.g. 'Refund order 4182'. References resolve, so name the actual thing: Refund {{order.data.id}}.
- `summary` - The values needed to decide, as label and value pairs: Amount, Customer, Reason. References like {{order.data.total}} are filled in when the approval is raised.
- `approverRole` - The lowest role allowed to decide. Admin by default: signing off is a privileged act, and viewers can never decide whatever this says.
- `slaHours` - How long the run waits before the SLA runs out. The wait is free: no compute is used while it is parked.
- `onExpiry` - Reject: take the rejected branch (the safe default, silence is not consent). Escalate: raise it once more, flagged urgent, then reject. Fail: stop the run so a person has to look.

## Output fields

- `decision`
- `approver`
- `approverRole`
- `reason`
- `at`
- `expired`
- `escalated`
- `selectedTargetIds`
- `orphanedTargetIds`
