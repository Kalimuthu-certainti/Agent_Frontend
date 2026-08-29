// Sends dev-agent approval mail via Microsoft Graph (app-only).
// Self-contained (Node built-ins + global fetch). Run by the Pages workflow's
// "send" job. Reads the Graph secret from the environment at run time only —
// never from a committed file, never logged. Recipients come from team.md.
//
// Env: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, MAIL_FROM,
//      GATE (or TO), SUBJECT, HTML, AGENT_TEAM_MD (default public/data/team.md)

import { readFileSync } from 'node:fs';

const ROUTABLE = ['RG-TL', 'RG-Dev', 'RG-Test', 'RG-Ver', 'RG-Sec', 'G4'];
const redact = s => String(s ?? '').replace(/(secret|password|bearer\s+[\w.\-]+)/gi, '[redacted]');
const die = m => { console.error('ERROR:', redact(m)); process.exit(1); };

function loadRouting(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { die(`team.md not found at ${path}`); }
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) die('no ```json routing block found in team.md');
  let cfg;
  try { cfg = JSON.parse(m[1]); } catch (e) { die('routing block is not valid JSON: ' + e.message); }
  return { from: cfg.from || null, people: cfg.people || [], groups: cfg.groups || [] };
}

const recipientsForGate = (r, gate) => (r.groups.find(g => g.gate === gate)?.emails || []).filter(Boolean);
const allowlist = r => new Set([
  ...r.people.map(p => p.email), ...r.groups.flatMap(g => g.emails || []), r.from,
].filter(Boolean).map(e => String(e).toLowerCase()));

async function getToken({ tenant, client, secret }) {
  if (!tenant || !client || !secret) die('missing GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET');
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) die(`token request failed (${res.status}): ${redact(j.error_description || j.error || 'unknown')}`);
  return j.access_token;
}

async function sendMail({ token, from, to, subject, html }) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: to.map(a => ({ emailAddress: { address: a } })) },
      saveToSentItems: true,
    }),
  });
  if (res.status !== 202) die(`sendMail failed (${res.status}): ${redact(await res.text().catch(() => '')).slice(0, 400)}`);
}

const env = process.env;
const routing = loadRouting(env.AGENT_TEAM_MD || 'public/data/team.md');
const from = env.MAIL_FROM || routing.from;
if (!from) die('no sender: set MAIL_FROM or a "from" in team.md');

let to;
if (env.GATE) {
  if (!ROUTABLE.includes(env.GATE)) die(`unknown gate "${env.GATE}"; expected one of ${ROUTABLE.join(', ')}`);
  to = recipientsForGate(routing, env.GATE);
  if (!to.length) die(`no recipients for ${env.GATE} in team.md`);
} else if (env.TO) {
  const allow = allowlist(routing);
  to = env.TO.split(',').map(s => s.trim()).filter(Boolean);
  const bad = to.filter(x => !allow.has(x.toLowerCase()));
  if (bad.length) die(`not in team.md allowlist: ${bad.join(', ')}`);
} else {
  die('set GATE (RG-Dev, RG-Test, G4, …) or TO (comma-separated, allowlisted)');
}

const subject = env.SUBJECT || '(dev-agent notification)';
const html = env.HTML || '<p>(no body)</p>';

console.log(`sending from ${from} to ${to.join(', ')}`);
const token = await getToken({ tenant: env.GRAPH_TENANT_ID, client: env.GRAPH_CLIENT_ID, secret: env.GRAPH_CLIENT_SECRET });
await sendMail({ token, from, to, subject, html });
console.log('OK — Graph returned 202');
