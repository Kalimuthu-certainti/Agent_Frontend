# Agent Control Panel

The operations surface for the dev-agent programme. One operator, two agents,
four questions: *is anything stuck, is anything waiting on me, are we burning
credit faster than expected, and what did the agents actually do?*

```bash
cd agent-control-panel
npm test                     # 26 server tests, zero dependencies
npm --prefix web install     # React 18 · Vite · Recharts
npm run build                # typecheck + build the web app
npm start                    # http://localhost:4180
```

For frontend work, `npm --prefix web run dev` gives HMR on :5173 and proxies
`/api` to :4180 — run `npm start` alongside it.

---

## The rule that shapes everything

**A value the log does not contain is never rendered as a number.**

Not `0`, not `—`, not a placeholder. It renders as *"not recorded yet"*, and a
chart with nothing to plot is withheld with an explanation rather than drawn as
a flat line at zero. A zero is a measurement; a null is an absence; confusing
the two is how a dashboard starts lying.

It is enforced in four places so it cannot erode by accident:

| Layer | Mechanism |
| --- | --- |
| `src/runLog.js` | an unmeasured field is written `null`, never defaulted |
| `src/reader.js` | `honestSum` returns `null` over zero recorded values, `0` only for a real zero — and reports a `*_recorded` count |
| `src/*.js` API | every aggregate ships its `*_recorded` count to the client |
| `web/src/ui.tsx` | `<Absent>` is the only path a missing value takes to the screen; `<Metric>` is the only path a number takes |

The first test in `test/reader.test.js` pins the "no data" vs "measured zero"
distinction, because that is the one that would rot first.

## Architecture

```
web/ (React 18 · Vite · Recharts)
   │  fetch /api/*
   ▼
src/server.js  ──►  RunLogReader  ├─ FileRunLogReader   ← today
                                  └─ PgRunLogReader     ← later
```

### Moving to Postgres

`src/server.js` has one line marked `THE SEAM`:

```js
const reader = new FileRunLogReader(LOG_PATH);
```

Write a `PgRunLogReader` with the same four methods — `agents()`, `runs()`,
`usage()`, `gates()` — returning the same shapes, and change that line. **No
endpoint changes. No UI changes.** The web app has no idea a file was ever
involved.

A reasonable first schema: one `agent_run_log` table with the record fields
below, indexed on `(ticket_key, ts)` and `(agent_name, ts)`. The aggregates in
`reader.js` map onto `GROUP BY` almost line for line.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/agents` | command deck: latest state per agent, today's spend |
| GET | `/api/runs?ticket_key=&limit=` | step timeline |
| GET | `/api/usage?days=` | series, and splits by ticket / agent / model |
| GET | `/api/gates?ticket_key=` | the seven-gate strip per ticket |
| GET | `/api/approvals` | queue + decided records |
| POST | `/api/approvals` | approve / bounce — idempotent by `request_id` |
| POST | `/api/requirements` | create a Jira requirement |
| GET | `/api/config` | what is wired and what is not |

## The record

One JSONL line per agent step, appended to `.agent/run-log.jsonl`
(override with `AGENT_RUN_LOG`):

```js
const { appendStep } = require('./src/runLog');

appendStep({
  run_id: 'r-8823',              // required
  agent_name: 'A',               // required
  claude_session_id: 'sess_01ab',
  model: 'claude-opus-5',
  ticket_key: 'TRDV2-570',
  phase: 'QA-1',
  step: 'jest suite',
  tokens_in: 18400, tokens_out: 2100,
  cost_usd: 0.42,
  context_pct: 63,               // drives the 75 / 90 rings
  gate: 'RG-Test',               // DoR RG-TL RG-Dev RG-Test RG-Ver RG-Sec G4
  verdict: 'pass',               // pass approved bounced blocked pending escalated
  pr_url, ci_state, solution_commit,
});
```

**Omit what you cannot measure.** It is stored as `null` and displayed honestly.
Never pass `0` to fill a gap.

`appendStep` throws on an unknown gate or verdict, an out-of-range
`context_pct`, a non-numeric token count, or a missing `run_id` / `agent_name`.
A corrupt log is worse than a missing one, because it looks like data.

## The five surfaces

**Command deck** — a tile per agent with the context ring as the primary visual.
Nominal below 75%, amber at 75% (*finishing current piece*), red at 90%
(*handing over*). The band is stated in words and the arc thickens with
severity, so it reads without colour. Four numbers above; the brief said resist
a fifth, and there isn't one.

**Ticket** — the gate strip is the hero: seven gates, each carrying a left
stripe whose weight encodes state. **`ready_to_merge` is only ever true when
every gate is recorded *and* clearing** — never inferred from an absence.

**Usage & credit** — spend over time with an emphasised endpoint, cost per
ticket sorted, splits by agent and model. One measure per axis; never a dual
axis.

**Approvals** — the queue, each item carrying PR, CI, solution commit and merge
state so a decision needs no other tab. Approve or bounce, bounce requires a
reason, and both require a named actor. Decisions are **idempotent by
`request_id`**: if the email path already decided, the UI shows that decision
instead of allowing a conflicting second one.

**Requirement editor** — writes into Jira. If Jira is not configured the form is
disabled and says which variables are missing, rather than failing on click.

## Configuration

| Variable | Effect |
| --- | --- |
| `PORT` | default `4180` |
| `AGENT_RUN_LOG` | run-log path |
| `AGENT_APPROVALS` | approval-record path |
| `JIRA_BASE_URL` `JIRA_EMAIL` `JIRA_API_TOKEN` `JIRA_PROJECT_KEY` | enables the requirement editor |

## What the seeded log contains

`.agent/run-log.jsonl` ships with **16 backfilled steps** from the first live
agent session — step zero, and TRDV2-570 through its Verifier bounce. The events
are real: the commits, Jira comments and PRs they name all exist.

But they were **reconstructed after the fact, not measured**. So every row is
`"source": "backfill"`, the UI badges it, and `tokens_in`, `tokens_out`,
`cost_usd` and `context_pct` are `null` — which is why the panel currently shows
"not recorded yet" for every cost and token figure, and withholds both charts.

That is the tool telling the truth about what was measured. Those surfaces fill
in the moment a live agent writes them.

## Honest limits

| | |
| --- | --- |
| **One writer per file** | `appendFileSync` is atomic enough for a single writer. Two agents on two machines is where Postgres stops being optional. |
| **No rotation** | the log grows unbounded; every request parses the whole file. Comfortable at thousands of lines, not millions. |
| **No auth** | binds to localhost. `POST /api/approvals` and `/api/requirements` are unauthenticated — put auth in front before exposing this anywhere. |
| **Actor is self-declared** | the approvals actor is typed by the operator, not authenticated. It is an audit *label*, not proof of identity. |
| **QA evidence** | the record carries no evidence-artefact fields yet, so the ticket view shows an empty state rather than a thumbnail gallery. |
| **No budget** | "spend today" has nothing to compare against until a budget is configured. It says so rather than inventing a target. |
