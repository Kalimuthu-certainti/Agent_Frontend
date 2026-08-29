# Agent Control Panel — Team surface update

This bundle is the control panel with the new **Team & routing** surface (a sixth
tab) plus its backend. Extract it over the control-panel root in `Agent_Frontend`
(the folder that already has `src/`, `web/`, `package.json`), keeping paths.

## Test the END-TO-END flow (real persistence) — locally

The GitHub Pages build is a **static, read-only showcase** — writes are inert
there. For a real E2E run (add people → form groups → route mail → it persists),
run the Node server:

```bash
npm test                 # 75 tests incl. 17 for team routing
npm --prefix web install
npm run build            # tsc + vite (normal mode)
npm start                # http://localhost:4180  → open the "Team" tab
```

Then, on the Team tab:
1. It loads the seeded team from `.agent/team.json` — 5 people, 4 groups, and
   **DoR, RG-TL and RG-Ver show red (unassigned)** so you can see the coverage guard.
2. Add a person, create a group, give it `RG-Ver`, add the person, then **Save
   routing** — nothing persists until Save. The red chip turns green; reload the
   page: it persisted to `.agent/team.json`.
3. Try to give `RG-Dev` to a second group → asked to confirm the move (one group
   per gate). A Security group offers no delegation — the toggle is locked to
   active review.

Recipients the Mailer will use come straight from this:
`GET /api/team` → gate → owning group → distribution list or active members.

## Static showcase (GitHub Pages)

The existing `.github/workflows/deploy-pages.yml` still builds with `VITE_STATIC=1`.
The Team tab renders from a synthetic snapshot and all writes show the honest
"read-only demo — run the full app" note. Nothing to change to deploy it.

## What changed (drop-in file list)

```
src/team.js              (new)   the store + guards + recipient resolution
src/server.js            (edit)  /api/team routes, PATCH branch, TeamError mapping,
                                 routing on the approvals queue
src/notify.js            (edit)  approval.recorded routes gate → owning group
.agent/team.json         (new)   seeded team (synthetic — edit in the UI)
test/team.test.js        (new)   17 tests
web/src/Team.tsx         (new)   the surface (draft model, Save routing bar)
web/src/types.ts         (edit)  TeamPerson / TeamGroup / TeamPayload / routing
web/src/api.ts           (edit)  patchJson helper
web/src/main.tsx         (edit)  rail entry + unsaved-draft navigation guard
web/src/theme.css        (edit)  coverage strip, group cards, drop zones, save bar
web/src/demoData.ts      (edit)  static /api/team snapshot
```

The seed uses `@example.com` placeholders on purpose — no real addresses in the
repo. Put real reviewer emails in through the UI (or edit `.agent/team.json`
locally); they are never committed.
