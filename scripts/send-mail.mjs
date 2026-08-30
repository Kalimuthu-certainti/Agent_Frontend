// Sends dev-agent approval mail via Microsoft Graph (app-only).
// Self-contained (Node built-ins + global fetch). The AGENT runs this directly —
// no GitHub, no workflow, no CI round-trip.
//
// Credentials are resolved at run time only, in this order, and are never
// committed and never logged:
//   1. the environment          (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, MAIL_FROM)
//   2. the macOS Keychain       (service "agent-graph", account = the var name)
//   3. ~/.config/agent/graph.env  (KEY=value lines, chmod 600)
//
// Recipients always come from team.json — a gate name resolves to that group's
// emails, and an explicit TO list is checked against the file's allowlist. The
// non-secret Graph identifiers (tenant, client, from) may live in that file too;
// the secret never does.
//
// Env: GATE (or TO), SUBJECT, HTML, AGENT_TEAM (default public/data/team.json)
//      DRY_RUN=1 (or --dry-run) resolves and prints the plan without sending.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROUTABLE = ['RG-TL', 'RG-Dev', 'RG-Test', 'RG-Ver', 'RG-Sec', 'G4'];
const redact = s => String(s ?? '').replace(/(secret|password|bearer\s+[\w.\-]+)/gi, '[redacted]');
const die = m => { console.error('ERROR:', redact(m)); process.exit(1); };

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

// ---- credential resolution ------------------------------------------------
// Each source is tried in turn; the first hit wins. Values are held in memory
// for the length of the call and are never printed.

const KEYCHAIN_SERVICE = process.env.AGENT_KEYCHAIN_SERVICE || 'agent-graph';
const CRED_FILE = process.env.AGENT_GRAPH_ENV || join(homedir(), '.config', 'agent', 'graph.env');

function fromKeychain(name) {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

let credFile = null;
function fromFile(name) {
  if (credFile === null) {
    try {
      credFile = Object.fromEntries(
        readFileSync(CRED_FILE, 'utf8').split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => {
            const i = l.indexOf('=');
            return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
          })
          .filter(Boolean));
    } catch { credFile = {}; }
  }
  return credFile[name] || null;
}

const sources = {};
function cred(name) {
  const env = process.env[name];
  if (env) { sources[name] = 'environment'; return env; }
  const kc = fromKeychain(name);
  if (kc) { sources[name] = 'keychain'; return kc; }
  const f = fromFile(name);
  if (f) { sources[name] = 'file'; return f; }
  sources[name] = 'MISSING';
  return null;
}

// ---- routing --------------------------------------------------------------

// team.json is the source of truth. A .md path is still accepted so an older
// checkout, where the routing was a ```json block inside the Markdown, keeps
// working rather than silently mailing nobody.
function loadRouting(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { die(`routing file not found at ${path}`); }

  let raw = text;
  if (path.endsWith('.md')) {
    const m = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!m) die(`no \`\`\`json routing block in ${path} — routing now lives in team.json`);
    raw = m[1];
  }

  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { die(`${path} is not valid JSON: ` + e.message); }
  return {
    from: cfg.from || null,
    graph: cfg.graph || {},
    people: cfg.people || [],
    groups: cfg.groups || [],
  };
}

const recipientsForGate = (r, gate) => (r.groups.find(g => g.gate === gate)?.emails || []).filter(Boolean);
const allowlist = r => new Set([
  ...r.people.map(p => p.email), ...r.groups.flatMap(g => g.emails || []), r.from,
].filter(Boolean).map(e => String(e).toLowerCase()));

// ---- Graph ----------------------------------------------------------------

async function getToken({ tenant, client, secret }) {
  if (!tenant || !client || !secret) {
    const missing = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'].filter(n => sources[n] === 'MISSING');
    die(`missing ${missing.join(', ')} — set them in the environment, the "${KEYCHAIN_SERVICE}" Keychain service, or ${CRED_FILE}`);
  }
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

// ---- main -----------------------------------------------------------------

const env = process.env;
const ROUTING_PATH = env.AGENT_TEAM || env.AGENT_TEAM_MD || 'public/data/team.json';
const routing = loadRouting(ROUTING_PATH);
let to;
if (env.GATE) {
  if (!ROUTABLE.includes(env.GATE)) die(`unknown gate "${env.GATE}"; expected one of ${ROUTABLE.join(', ')}`);
  to = recipientsForGate(routing, env.GATE);
  if (!to.length) die(`no recipients for ${env.GATE} in ${ROUTING_PATH}`);
} else if (env.TO) {
  const allow = allowlist(routing);
  to = env.TO.split(',').map(s => s.trim()).filter(Boolean);
  const bad = to.filter(x => !allow.has(x.toLowerCase()));
  if (bad.length) die(`not in the ${ROUTING_PATH} allowlist: ${bad.join(', ')}`);
} else {
  die('set GATE (RG-Dev, RG-Test, G4, …) or TO (comma-separated, allowlisted)');
}

const from = cred('MAIL_FROM') || routing.from;
if (!from) die(`no sender: set MAIL_FROM, or a "from" in ${ROUTING_PATH}`);

const subject = env.SUBJECT || '(dev-agent notification)';
const html = env.HTML || '<p>(no body)</p>';

// Identifiers may also come from the routing file, between the environment and
// the Keychain. The secret is never read from the file.
function ident(name, fromFile) {
  const e = process.env[name];
  if (e) { sources[name] = 'environment'; return e; }
  if (fromFile) { sources[name] = ROUTING_PATH; return fromFile; }
  return cred(name);
}
const tenant = ident('GRAPH_TENANT_ID', routing.graph?.tenantId);
const client = ident('GRAPH_CLIENT_ID', routing.graph?.clientId);
const secret = cred('GRAPH_CLIENT_SECRET');

console.log(`gate:       ${env.GATE || '(explicit TO)'}`);
console.log(`from:       ${from}`);
console.log(`to:         ${to.join(', ')}`);
console.log(`subject:    ${subject}`);
console.log(`body:       ${html.length} bytes of HTML`);
console.log(`credentials: ${['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'].map(n => `${n}=${sources[n]}`).join(', ')}`);

if (DRY_RUN) {
  console.log('\nDRY RUN — resolved only, nothing sent.');
  process.exit(0);
}

const token = await getToken({ tenant, client, secret });
await sendMail({ token, from, to, subject, html });
console.log('OK — Graph returned 202');
