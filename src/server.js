'use strict';

/**
 * Agent Control Panel — API + static host. Node built-ins only.
 *
 *   GET  /api/agents                    command deck
 *   GET  /api/runs?ticket_key=&limit=   step timeline
 *   GET  /api/usage?days=               spend and tokens
 *   GET  /api/gates?ticket_key=         gate strips
 *   GET  /api/approvals                 pending queue + decided records
 *   POST /api/approvals                 approve / bounce  (idempotent by request_id)
 *   POST /api/requirements              create or update a Jira requirement
 *   GET  /api/config                    what is wired and what is not
 *
 * To move to Postgres: construct a PgRunLogReader on the line marked THE SEAM.
 * Nothing else here, and nothing in web/, changes.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { FileRunLogReader } = require('./reader');
const { FileApprovalStore, ApprovalError } = require('./approvals');
const { DEFAULT_LOG_PATH, GATE_ORDER } = require('./runLog');

const PORT = Number(process.env.PORT || 4180);
const LOG_PATH = process.env.AGENT_RUN_LOG || DEFAULT_LOG_PATH;
const WEB_DIR = path.join(__dirname, '..', 'web', 'dist');

// ---- THE SEAM -------------------------------------------------------------
const reader = new FileRunLogReader(LOG_PATH);
// ---------------------------------------------------------------------------
const approvals = new FileApprovalStore();

/** Jira is optional. Absent config is reported, never faked. */
const jira = {
  base_url: process.env.JIRA_BASE_URL || null,
  email: process.env.JIRA_EMAIL || null,
  token: process.env.JIRA_API_TOKEN || null,
  project: process.env.JIRA_PROJECT_KEY || null,
};
const jiraConfigured = () => Boolean(jira.base_url && jira.email && jira.token && jira.project);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const clampInt = (raw, fallback, min, max) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * The approvals queue: every gate that is bounced or awaiting a human, joined
 * to any decision already recorded. Derived from the log — never invented.
 */
function approvalQueue() {
  const decided = approvals.all();
  const byRequest = new Map(decided.map(d => [d.request_id, d]));
  const items = [];

  for (const t of reader.gates()) {
    for (const g of t.gates) {
      const needsHuman = g.recorded && (g.verdict === 'pending' || g.verdict === 'bounced' || g.verdict === 'escalated');
      if (!needsHuman) continue;
      const request_id = `${t.ticket_key}:${g.gate}`;
      items.push({
        request_id,
        ticket_key: t.ticket_key,
        gate: g.gate,
        verdict: g.verdict,
        raised_at: g.ts,
        raised_by: g.by,
        note: g.note,
        pr_url: t.pr_url,
        ci_state: t.ci_state,
        solution_commit: t.solution_commit,
        blocked: t.blocked,
        blocking_gates: t.blocking_gates,
        ready_to_merge: t.ready_to_merge,
        decision: byRequest.get(request_id) || null,
      });
    }
  }
  return { items, decided, gate_order: GATE_ORDER };
}

async function createRequirement(payload) {
  const summary = String(payload.summary || '').trim();
  if (!summary) throw new ApprovalError('summary is required', 'BAD_REQUEST');

  if (!jiraConfigured()) {
    const missing = Object.entries(jira).filter(([, v]) => !v)
      .map(([k]) => `JIRA_${k.toUpperCase()}`);
    const err = new ApprovalError('Jira is not configured on this server', 'NOT_CONFIGURED');
    err.missing = missing;
    throw err;
  }

  const labels = payload.agent_eligible ? ['agent-eligible'] : [];
  const body = {
    fields: {
      project: { key: jira.project },
      summary,
      issuetype: { name: payload.issue_type || 'Task' },
      labels,
      ...(payload.description ? { description: payload.description } : {}),
    },
  };
  const auth = Buffer.from(`${jira.email}:${jira.token}`).toString('base64');
  const res = await fetch(`${jira.base_url.replace(/\/$/, '')}/rest/api/3/issue`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApprovalError(
      (json && (json.errorMessages || []).join('; ')) || `Jira returned ${res.status}`, 'JIRA_ERROR');
    throw err;
  }
  return json;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(WEB_DIR, rel);
  const root = path.resolve(WEB_DIR);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback so client-side routes resolve on refresh.
      fs.readFile(path.join(root, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('The web app is not built. Run: npm run build');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendJson(res, 400, { error: 'bad_request', message: 'unparseable URL' }); }
  const { pathname, searchParams } = url;

  try {
    if (req.method === 'GET') {
      if (pathname === '/api/agents') {
        const meta = reader.readAll();
        return sendJson(res, 200, {
          agents: reader.agents(),
          log_exists: meta.exists,
          malformed_lines: meta.malformed,
          log_path: LOG_PATH,
        });
      }
      if (pathname === '/api/runs') {
        return sendJson(res, 200, reader.runs({
          ticket_key: searchParams.get('ticket_key') || undefined,
          limit: clampInt(searchParams.get('limit'), 200, 1, 1000),
        }));
      }
      if (pathname === '/api/usage') {
        return sendJson(res, 200, reader.usage({ days: clampInt(searchParams.get('days'), 14, 1, 365) }));
      }
      if (pathname === '/api/gates') {
        return sendJson(res, 200, {
          tickets: reader.gates({ ticket_key: searchParams.get('ticket_key') || undefined }),
          gate_order: GATE_ORDER,
        });
      }
      if (pathname === '/api/approvals') return sendJson(res, 200, approvalQueue());
      if (pathname === '/api/config') {
        return sendJson(res, 200, {
          log_path: LOG_PATH,
          jira_configured: jiraConfigured(),
          jira_project: jiraConfigured() ? jira.project : null,
          reader: reader.constructor.name,
        });
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not_found', message: `no endpoint ${pathname}` });
      }
      return serveStatic(res, pathname);
    }

    if (req.method === 'POST') {
      const payload = await readBody(req);
      if (pathname === '/api/approvals') {
        const { record, created } = approvals.decide({ ...payload, channel: 'ui' });
        return sendJson(res, created ? 201 : 200, { record, created });
      }
      if (pathname === '/api/requirements') {
        const issue = await createRequirement(payload);
        return sendJson(res, 201, { issue });
      }
      return sendJson(res, 404, { error: 'not_found', message: `no endpoint ${pathname}` });
    }

    return sendJson(res, 405, { error: 'method_not_allowed', message: `${req.method} is not supported here` });
  } catch (err) {
    if (err instanceof ApprovalError) {
      const status = err.code === 'CONFLICT' ? 409
        : err.code === 'NOT_CONFIGURED' ? 501
        : err.code === 'JIRA_ERROR' ? 502 : 400;
      return sendJson(res, status, {
        error: err.code, message: err.message,
        ...(err.existing ? { existing: err.existing } : {}),
        ...(err.missing ? { missing: err.missing } : {}),
      });
    }
    // Say what actually broke. "Something went wrong" is the anti-pattern.
    return sendJson(res, 500, { error: 'server_error', message: String((err && err.message) || err) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    process.stdout.write(`agent-control-panel  http://localhost:${PORT}\n`);
    process.stdout.write(`run log              ${LOG_PATH}${fs.existsSync(LOG_PATH) ? '' : '  (not created yet)'}\n`);
    process.stdout.write(`jira                 ${jiraConfigured() ? `configured (${jira.project})` : 'not configured — the requirement editor will say so'}\n`);
    if (!fs.existsSync(WEB_DIR)) process.stdout.write(`web app              not built — run: npm run build\n`);
  });
}

module.exports = { server, reader, approvals, approvalQueue };
