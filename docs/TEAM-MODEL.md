# Team management — data model & rules

**Why this exists:** the Mailer decides *who gets an approval request* by reading
**only** this model. Changing who is mailed for a gate is a **UI action, never a
code change**. No email address is ever hardcoded in a service, a workflow, or a
ticket.

Status: **specified, not yet built into the panel UI.** This document is the
contract the UI and the `RunLogReader`/Mailer seams implement.

---

## What the operator does in the UI

Add a person (name + email) → create a group → drag people into groups → assign
each group a role-gate. That's it. The Mailer follows.

## The data

```
PERSON
  id
  name
  email
  active            (bool — inactive people are never mailed, never count)
  jira_account
  github_handle

GROUP
  id
  name
  type              dev | qa | devops | ba | security
  group_email       optional — the distribution-list address
  members           [person_id]
  owns_gate         RG-Dev | RG-Test | RG-Ver | G4 | RG-BA | RG-Sec
  approval_mode     active-review | standing-delegation
  escalation_order  [person_id]           (rung order for reminders)
  timeout_hours     per rung              (how long before escalating a rung)
```

## How the Mailer uses it

When an agent needs an approval for a gate:

1. Look up the group whose `owns_gate` == that gate.
2. Mail the group: `group_email` if set, otherwise every **active** member.
3. **Only replies from those member addresses count.** A reply from anyone else
   is ignored **and flagged** (surfaced in the panel, not silently dropped).
4. On no reply within a rung's `timeout_hours`, escalate to the next person in
   `escalation_order`.

Gate → group mapping the agent asks for:

| Agent needs | Gate | Group type |
| --- | --- | --- |
| Solution-doc approval | `RG-Dev` | dev |
| QA sign-off | `RG-Test` | qa |
| Merge permission | `G4` | devops |
| BA / requirement sign-off | `RG-BA` | ba |
| Security review | `RG-Sec` | security |

## Guards the UI MUST enforce

- **Every gate has at least one group.** An unassigned gate means an approval
  request that goes nowhere — the UI shows a **loud warning** until it's fixed.
- **No group is empty.** A group with no active members cannot own a gate.
- **The Security group is always `active-review`** — never `standing-delegation`.
  The UI does not offer delegation for it.
- A person with `active = false` is never mailed and never counts as an
  approver, even if still listed in a group or escalation order.

## Where it fits the existing panel

This model sits behind the same **swappable reader seam** as the run log
(`src/server.js`, the `// ---- THE SEAM ----` line). File-backed first
(`.agent/team.json`), the same shape moves to Postgres later with no UI change.
The honesty rule still holds: a gate with no group renders the warning, never a
silent empty state that looks configured.
