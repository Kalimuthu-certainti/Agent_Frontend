# Agent Control Panel — Team surface update

This bundle is the control panel with the new **Team & routing** surface (a sixth
tab) plus its backend. Extract it over the control-panel root in `Agent_Frontend`
(the folder that already has `src/`, `web/`, `package.json`), keeping paths.

## Test the END-TO-END flow (real persistence) — locally

The GitHub Pages build is a **static, read-only showcase** — writes are inert
there. For a real E2E run (add people → form groups → route mail → it persists),
run the Node server:

```bash
npm test                 # 39 tests incl. 13 for team routing
npm --prefix web install
npm run build            # tsc + vite (normal mode)
npm start                # http://localhost:4180  → open the "Team" tab
```

Then, on the Team tab:
1. It loads the seeded team from `.agent/team.json` — 5 people, 4 groups, and
   **RG-TL and RG-Ver show red (unassigned)** so you can see the coverage guard.
2. Add a person, create a group, give it `RG-Ver`, add the person — the red chip
   turns green. Reload the page: it persisted to `.agent/team.json`.
3. Try to give `RG-Dev` to a second group → refused (one group per gate). Try a
   Security group with delegation → forced back to active-review.

Recipients the Mailer will use come straight from this:
`GET /api/team` → gate → owning group → distribution list or active members.

## Static showcase (GitHub Pages)

The existing `.github/workflows/deploy-pages.yml` still builds with `VITE_STATIC=1`.
The Team tab renders from a synthetic snapshot and all writes show the honest
"read-only demo — run the full app" note. Nothing to change to deploy it.

## What changed (drop-in file list)

```
src/team.js              (new)   the store + guards + recipient resolution
src/server.js            (edit)  /api/team routes + TeamError mapping
.agent/team.json         (new)   seeded team (synthetic — edit in the UI)
test/team.test.js        (new)   13 tests
web/src/Team.tsx         (new)   the surface
web/src/types.ts         (edit)  Person / Group / TeamState
web/src/api.ts           (edit)  patchJson helper
web/src/main.tsx         (edit)  rail entry
web/src/demoData.ts      (edit)  static /api/team snapshot
```

The seed uses `@example.com` placeholders on purpose — no real addresses in the
repo. Put real reviewer emails in through the UI (or edit `.agent/team.json`
locally); they are never committed.
