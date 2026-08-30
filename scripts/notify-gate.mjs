// The AGENT calls this in its flow to notify a gate. Fires a repository_dispatch
// that runs the "send" job in deploy-pages.yml. Nothing auto-triggers.
// Needs: GH_TOKEN (token with actions:write), GITHUB_REPOSITORY (owner/repo).
// Usage: node scripts/notify-gate.mjs RG-Dev "Subject" "<p>body</p>"

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
  console.log(`dispatched send-mail for gate ${gate}`);
} else {
  console.error(`dispatch failed (${res.status}): ${await res.text().catch(() => '')}`);
  process.exit(1);
}
