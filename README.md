# Agent Control — Frontend (static demo)

The operations dashboard for the dev-agent programme, published to **GitHub Pages**
as a **static demo**: the full UI, driven by **synthetic** data, with the backend
disconnected. Approve / Bounce and the Jira editor are inert here by design.

**Live demo:** enable Pages (below), then it publishes to
`https://<your-user>.github.io/Agent_Frontend/`

## Why it's a demo, not the tool

GitHub Pages serves static files only. This app has a Node backend that reads the
run log and *writes* approvals and Jira tickets — none of that can run on Pages.
So the Pages build bakes in a synthetic snapshot and disables the writes, honestly
labelled at the top of every screen.

Nothing in this demo is real: the agents, tickets, PR links and session ids are
all invented. No internal data is published.

## Enable Pages (one time)

1. Push this repo (already done if you're reading it on GitHub).
2. **Settings → Pages → Build and deployment → Source: “GitHub Actions”.**
3. The workflow in `.github/workflows/deploy-pages.yml` builds and deploys on
   every push to `main`. First run may take a minute.

If you rename the repo, update `VITE_BASE` in that workflow to `/<new-name>/`.
With a custom domain, set it to `/`.

## Run the real, working tool locally

```bash
npm test                     # backend tests
npm --prefix web install
npm run build                # normal (non-demo) build
npm start                    # UI + live API on http://localhost:4180
```

In the real build the screens read a live run log and the Approve / Bounce and
requirement actions write for real. See the backend under `src/` and the record
contract in the code comments.

## Build the static demo yourself

```bash
cd web
VITE_STATIC=1 VITE_BASE=/Agent_Frontend/ npm run build   # → web/dist
```
