# Team & mail routing

**The routing lives in [`team.json`](./team.json), not here.** That file is what
the agent reads and what `scripts/send-mail.mjs` sends to. This page is prose —
context a person needs that a machine does not.

Edit the routing on the **Team & mail** surface of the dashboard: change the
recipients there, download the `team.json` it produces, and commit it. The commit
is the audit trail of who changed a mail recipient and when.

## Who is on the rota

| Gate | What it approves | Who |
| --- | --- | --- |
| `RG-Dev` | The solution document, before any code is written | Prithinga Senthilkumar |
| `RG-Test` | QA evidence, before the PR is raised | Mahitha Nalu |
| `G4` | Permission to merge | Kalimuthu Kuppusamy |
| `RG-TL` | Technical-lead sign-off | **unassigned** |
| `RG-Ver` | Adversarial verification | **unassigned** |
| `RG-Sec` | Security review | **unassigned** |

`RG-TL`, `RG-Ver` and `RG-Sec` have no group, so the coverage strip above flags
them red — an approval request for one of those would reach nobody. The agent
must escalate to a human rather than assume the gate passed.

## Review modes

- **`active-review`** — a named person has to reply `APPROVED`. Silence is not
  approval, and the agent waits.
- **`standing-delegation`** — approval was agreed in advance for a class of
  change, so the agent proceeds and records the delegation on the run log.

## What is not in these files

The Microsoft Graph **client secret** is never committed, never written here, and
never logged. It is read at run time from the local environment, the macOS
Keychain, or `~/.config/agent/graph.env`. The tenant and client IDs are
identifiers rather than secrets, so they sit in `team.json` where the UI can set
them — but the secret only ever exists on the machine doing the sending.

Mail is also **allowlisted to this routing**: `send-mail.mjs` refuses to send to
any address that does not appear in `team.json`.
