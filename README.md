# Agent Control Panel

A **read-only** dashboard for the Dev Agent Programme. **No backend, no database.**
It shows the agent's work by reading the files the agent commits into this repo:

```
public/data/run-log.jsonl   the agent's work — one JSON step per line
public/data/team.md         mail routing, edited in Markdown by the agent
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
- **Team & mail** — renders `data/team.md` and reads its `json` block to show who
  is mailed for each gate.

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
- **Mail:** edit the `json` block in `public/data/team.md` — `groups` map a gate
  to recipient emails. The coverage strip flags any gate with no group in red.

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

Recipients come from `public/data/team.md`: a gate resolves to that group's
`emails`, and an explicit `TO=` list is checked against the file's allowlist. The
sender can only reach an address that appears in that file.

### One-time credential setup

The Graph app-only credentials are read at run time and are never committed and
never logged. `send-mail.mjs` looks in three places, first hit wins:

1. the environment — `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `MAIL_FROM`
2. the macOS Keychain, service `agent-graph`, account = the variable name
3. `~/.config/agent/graph.env` (`KEY=value` lines, `chmod 600`)

The Keychain is the recommended one. Store each value once — run these yourself
so the secret never passes through a terminal transcript or a chat log:

```bash
security add-generic-password -U -s agent-graph -a GRAPH_TENANT_ID     -w
security add-generic-password -U -s agent-graph -a GRAPH_CLIENT_ID     -w
security add-generic-password -U -s agent-graph -a GRAPH_CLIENT_SECRET -w
security add-generic-password -U -s agent-graph -a MAIL_FROM           -w
```

Ending each with a bare `-w` makes `security` prompt for the value instead of
taking it from the command line, so it stays out of your shell history.

Because mail no longer goes through Actions, the `GRAPH_*` and `MAIL_FROM`
entries in this repo's Actions Secrets are no longer used and can be deleted.
