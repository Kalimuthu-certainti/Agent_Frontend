// The AGENT calls this, in its own flow, when it decides to notify a gate.
// It fires a repository_dispatch that runs the "send" job in deploy-pages.yml.
// Nothing auto-triggers — the agent chooses the moment (e.g. after committing the
// solution doc, or after opening the PR).
//
// Needs in the environment:
//   GH_TOKEN            a GitHub token with `actions:write` on this repo
//   GITHUB_REPOSITORY   owner/repo (defaults to Kalimuthu-certainti/Agent_Frontend)
//
// Usage:
//   node scripts/notify-gate.mjs RG-Dev "Review: TRDV2-570" "<p>Please review the solution doc.</p>"
//   node scripts/notify-gate.mjs G4    "Merge permission: TRDV2-570" "<p>PR is green. OK to merge?</p>"

const [gate, subject, html] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY || 'Kalimuthu-certainti/Agent_Frontend';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!token) { console.error('ERROR: set GH_TOKEN (a token with actions:write)'); process.exit(1); }
if (!gate) { console.error('usage: notify-gate.mjs <GATE> <subject> <html>'); process.exit(1); }

const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ event_type: 'send-mail', client_payload: { gate, subject: subject || '', html: html || '' } }),
});

if (res.status === 204) {
  console.log(`dispatched send-mail for gate ${gate} → the workflow will mail its recipients from team.md`);
} else {
  console.error(`dispatch failed (${res.status}): ${await res.text().catch(() => '')}`);
  process.exit(1);
}
