# Agent Control Panel

A **read-only** dashboard for the Dev Agent Programme. **No backend, no database.**
It shows the agent's work by reading the files the agent commits into this repo:

```
public/data/run-log.jsonl   the agent's work — one JSON step per line
public/data/team.json       mail routing — the source of truth
public/data/team.md         prose notes about the rota, rendered beside it
```

The dashboard fetches those static files and renders them. That's it — it runs
happily on GitHub Pages with nothing running server-side.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
```

## Build / deploy (GitHub Pages)

```bash
npm run build      # outputs dist/
```

Deploy is automatic via `.github/workflows/deploy-pages.yml`:

1. Repo **Settings → Pages → Build and deployment → Source: “GitHub Actions.”**
2. Push to `main`. The workflow builds with base `/Agent_Frontend/` and publishes.
3. If you rename the repo or use a custom domain, change `VITE_BASE` in that
   workflow accordingly (`/` for a domain root).

## The five surfaces

- **Command deck** — a tile per agent, the context ring as the primary signal
  (75% amber, 90% red).
- **Tickets** — the seven-gate strip, timeline and evidence for one ticket.
- **Usage & credit** — spend and tokens over time, split by ticket / agent / model.
- **Approvals** — gates the agent recorded as waiting on a human (read-only;
  decisions happen over email).
- **Team & mail** — the one editable surface. Shows who is mailed for each gate,
  lets you change it, and hands back a `team.json` to commit. It cannot save on
  its own: this is a static page with no server behind it, so the commit is what
  makes a change real — and is the audit trail of who changed a recipient.

## The honesty rule

A value the run log does not contain is **never** rendered as a number — not `0`,
not a placeholder. It renders as *"not recorded yet"*, and a chart with nothing
to plot is withheld with an explanation. A zero is a measurement; a null is an
absence.

## How the agent feeds it

- **Work:** append one JSON line per step to `public/data/run-log.jsonl`. Fields:
  `ts, run_id, agent_name, model, ticket_key, phase, step, tokens_in, tokens_out,
  cost_usd, context_pct, gate, verdict, note, pr_url, ci_state, solution_commit,
  source`. Omit what you can't measure (it shows as "not recorded yet") — never
  pass `0` to fill a gap. Gates: `DoR RG-TL RG-Dev RG-Test RG-Ver RG-Sec G4`;
  verdicts: `pass approved bounced blocked pending escalated`.
- **Mail:** edit it on the Team & mail surface, download `team.json`, replace
  `public/data/team.json` and commit. `groups` map a gate to recipient emails, and
  the coverage strip flags any gate with no group in red. Editing the file by hand
  works just as well — the UI is a convenience, not a gatekeeper.

Commit the updated files and redeploy; the dashboard reflects them.

## Sending gate mail (the agent does this itself)

The agent sends approval mail **directly**, from wherever it is running. There is
no workflow step, no `repository_dispatch`, and no GitHub token in the path — the
Pages workflow only ever builds and deploys the dashboard.

```bash
node scripts/notify-gate.mjs RG-Dev "Review: TRDV2-600" "<p>Please review the solution doc.</p>"
```

The third argument may be a path to an HTML file instead of inline markup, which
is what solution-doc mails use. Add `--dry-run` to resolve the gate, recipients
and credentials and print the plan **without sending** — always worth doing once
before a real send.

Recipients come from `public/data/team.json`: a gate resolves to that group's
`emails`, and an explicit `TO=` list is checked against the file's allowlist. The
sender can only reach an address that appears in that file.

### One-time credential setup

The Graph app-only credentials are read at run time and are never committed and
never logged. `send-mail.mjs` looks in three places, first hit wins:

1. the environment — `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `MAIL_FROM`
2. `team.json` — for the **tenant ID, client ID and `from`** only; these are
   identifiers rather than secrets, so the dashboard has fields for them
3. the macOS Keychain, service `agent-graph`, account = the variable name
4. `~/.config/agent/graph.env` (`KEY=value` lines, `chmod 600`)

The **client secret is never read from `team.json`** — only from the environment,
the Keychain, or that file. There is deliberately no field for it in the UI.

Put the tenant ID, client ID and sender in `team.json` via the dashboard, and the
secret in the Keychain. That is a single command, run once, by you — so the secret
never passes through a terminal transcript or a chat log:

```bash
security add-generic-password -U -s agent-graph -a GRAPH_CLIENT_SECRET -w
```

The bare `-w` at the end makes `security` prompt for the value instead of taking
it from the command line, so it stays out of your shell history.

Because mail no longer goes through Actions, the `GRAPH_*` and `MAIL_FROM`
entries in this repo's Actions Secrets are no longer used and can be deleted.
