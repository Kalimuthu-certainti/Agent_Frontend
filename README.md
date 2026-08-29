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
