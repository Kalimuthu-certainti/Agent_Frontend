'use strict';

/**
 * RunLogReader — the swappable seam.
 *
 * The API layer and the entire UI speak only to this shape. Replacing the file
 * with Postgres means writing a PgRunLogReader with these four methods and
 * changing one line in server.js. No endpoint changes. No UI changes.
 *
 *   interface RunLogReader {
 *     agents(): AgentState[]
 *     runs({ ticket_key, limit }): { rows, total, truncated, malformed }
 *     usage({ days }): { series, byTicket, byAgent, byModel, totals }
 *     gates({ ticket_key }): TicketGates[]
 *   }
 *
 * THE HONESTY RULE lives here, not in the UI:
 * an aggregate over zero recorded values is `null`, never `0`. Each numeric
 * aggregate ships a `*_recorded` count so callers can distinguish "nobody ever
 * wrote this" from "this was measured and it was zero".
 */

const fs = require('fs');
const { GATE_ORDER, CLEARING_VERDICTS, DEFAULT_LOG_PATH } = require('./runLog');

function honestSum(rows, key) {
  let total = 0;
  let recorded = 0;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    total += n;
    recorded += 1;
  }
  return { value: recorded === 0 ? null : total, recorded };
}

/** Roll a row-set into the numeric shape every surface consumes. */
function summarise(rows) {
  const cost = honestSum(rows, 'cost_usd');
  const tin = honestSum(rows, 'tokens_in');
  const tout = honestSum(rows, 'tokens_out');
  return {
    steps: rows.length,
    cost_usd: cost.value, cost_recorded: cost.recorded,
    tokens_in: tin.value, tokens_in_recorded: tin.recorded,
    tokens_out: tout.value, tokens_out_recorded: tout.recorded,
    tokens_total: (tin.recorded + tout.recorded) === 0
      ? null : (tin.value || 0) + (tout.value || 0),
    tokens_total_recorded: tin.recorded + tout.recorded,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

const dayOf = r => String(r.ts || '').slice(0, 10) || null;

class FileRunLogReader {
  constructor(logPath = DEFAULT_LOG_PATH) {
    this.logPath = logPath;
  }

  readAll() {
    let raw;
    try {
      raw = fs.readFileSync(this.logPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { rows: [], malformed: 0, exists: false };
      throw err;
    }
    const rows = [];
    let malformed = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { rows.push(JSON.parse(trimmed)); } catch { malformed += 1; }
    }
    rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
    return { rows, malformed, exists: true };
  }

  /** Latest state per agent, plus today's spend and the checkpoint clock. */
  agents() {
    const { rows } = this.readAll();
    const today = new Date().toISOString().slice(0, 10);
    const out = [];

    for (const [agent_name, agentRows] of groupBy(rows, r => r.agent_name)) {
      const latest = agentRows[agentRows.length - 1];
      const todays = agentRows.filter(r => dayOf(r) === today);

      let context_band = null;
      if (latest.context_pct != null) {
        const pct = Number(latest.context_pct);
        context_band = pct >= 90 ? 'handover' : pct >= 75 ? 'warning' : 'nominal';
      }

      // Time since the last step, which is the hourly-checkpoint clock.
      let minutes_since_step = null;
      if (latest.ts) {
        const t = Date.parse(latest.ts);
        if (Number.isFinite(t)) minutes_since_step = Math.max(0, Math.round((Date.now() - t) / 60000));
      }

      out.push({
        agent_name,
        run_id: latest.run_id,
        claude_session_id: latest.claude_session_id,
        model: latest.model,
        ticket_key: latest.ticket_key,
        phase: latest.phase,
        step: latest.step,
        context_pct: latest.context_pct,
        context_band,
        last_step_at: latest.ts,
        minutes_since_step,
        source: latest.source,
        steps_logged: agentRows.length,
        today: summarise(todays),
      });
    }
    out.sort((a, b) => String(b.last_step_at || '').localeCompare(String(a.last_step_at || '')));
    return out;
  }

  runs({ ticket_key, limit = 200 } = {}) {
    const { rows, malformed, exists } = this.readAll();
    const filtered = ticket_key ? rows.filter(r => r.ticket_key === ticket_key) : rows;
    const page = filtered.slice().reverse().slice(0, limit);
    return {
      rows: page,
      total: filtered.length,
      truncated: filtered.length > page.length,
      malformed,
      log_exists: exists,
    };
  }

  usage({ days = 14 } = {}) {
    const { rows } = this.readAll();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const recent = rows.filter(r => dayOf(r) >= cutoff);

    const asList = (map) => [...map.entries()]
      .map(([key, rs]) => ({ key, ...summarise(rs) }));

    return {
      // time series, oldest → newest, for the area chart
      series: asList(groupBy(recent, dayOf)).sort((a, b) => a.key.localeCompare(b.key)),
      byTicket: asList(groupBy(rows, r => r.ticket_key))
        .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0) || b.steps - a.steps),
      byAgent: asList(groupBy(rows, r => r.agent_name)),
      byModel: asList(groupBy(rows, r => r.model)),
      totals: summarise(rows),
      window_days: days,
    };
  }

  /**
   * Gate strip per ticket. Latest verdict per gate wins.
   * A gate never recorded is `pending` with `recorded: false` — never a pass.
   */
  gates({ ticket_key } = {}) {
    const { rows } = this.readAll();
    const withGate = rows.filter(r => r.gate && r.ticket_key);
    const keys = ticket_key ? [ticket_key] : [...new Set(withGate.map(r => r.ticket_key))];

    return keys.map(key => {
      const forTicket = withGate.filter(r => r.ticket_key === key);
      const allRows = rows.filter(r => r.ticket_key === key);
      const gates = GATE_ORDER.map(gate => {
        const hits = forTicket.filter(r => r.gate === gate);
        if (hits.length === 0) {
          return { gate, verdict: 'pending', recorded: false, ts: null, by: null, note: null };
        }
        const latest = hits[hits.length - 1];
        return {
          gate,
          verdict: latest.verdict || 'pending',
          recorded: true,
          ts: latest.ts,
          by: latest.agent_name,
          note: latest.note,
          source: latest.source,
        };
      });

      const blocking = gates.filter(g => g.verdict === 'bounced' || g.verdict === 'blocked');
      const latestWith = k => {
        const hit = allRows.filter(r => r[k] != null).pop();
        return hit ? hit[k] : null;
      };

      return {
        ticket_key: key,
        gates,
        blocked: blocking.length > 0,
        blocking_gates: blocking.map(g => g.gate),
        // Never true on assumption. Every gate must be recorded AND clearing.
        ready_to_merge: gates.every(g => g.recorded && CLEARING_VERDICTS.includes(g.verdict)),
        pr_url: latestWith('pr_url'),
        ci_state: latestWith('ci_state'),
        solution_commit: latestWith('solution_commit'),
        steps: allRows.length,
        last_activity: allRows.length ? allRows[allRows.length - 1].ts : null,
      };
    }).sort((a, b) => String(a.ticket_key).localeCompare(String(b.ticket_key)));
  }
}

module.exports = { FileRunLogReader, honestSum, summarise };
