/**
 * Client-side run-log reader — the browser port of the old server reader.
 *
 * There is NO backend. The dashboard fetches the run log the agent commits
 * (public/data/run-log.jsonl) and computes every surface from it, in the
 * browser, read-only.
 *
 * THE HONESTY RULE is enforced here, not in the UI: an aggregate over zero
 * recorded values is `null`, never `0`, and every numeric aggregate ships a
 * `*_recorded` count so "nobody wrote this" is distinct from "measured zero".
 */

import { GATE_ORDER, CLEARING_VERDICTS } from './runlog';
import type { AgentState, GatesPayload, RunsPayload, Step, Summary, TicketGates, Usage } from './types';

export type Row = Partial<Step> & Record<string, unknown>;

function honestSum(rows: Row[], key: keyof Row) {
  let total = 0, recorded = 0;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    total += n; recorded += 1;
  }
  return { value: recorded === 0 ? null : total, recorded };
}

function summarise(rows: Row[]): Summary {
  const cost = honestSum(rows, 'cost_usd');
  const tin = honestSum(rows, 'tokens_in');
  const tout = honestSum(rows, 'tokens_out');
  return {
    steps: rows.length,
    cost_usd: cost.value, cost_recorded: cost.recorded,
    tokens_in: tin.value, tokens_in_recorded: tin.recorded,
    tokens_out: tout.value, tokens_out_recorded: tout.recorded,
    tokens_total: (tin.recorded + tout.recorded) === 0 ? null : (tin.value || 0) + (tout.value || 0),
    tokens_total_recorded: tin.recorded + tout.recorded,
  };
}

function groupBy<K>(rows: Row[], keyFn: (r: Row) => K | null | undefined): Map<K, Row[]> {
  const map = new Map<K, Row[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

const dayOf = (r: Row) => String(r.ts || '').slice(0, 10) || null;

/** Parse the JSONL text the agent commits. Bad lines are counted, not fatal. */
export function parseRunLog(text: string): { rows: Row[]; malformed: number } {
  const rows: Row[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { malformed += 1; }
  }
  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return { rows, malformed };
}

export function agents(rows: Row[]): AgentState[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: AgentState[] = [];
  for (const [agent_name, agentRows] of groupBy(rows, r => r.agent_name as string)) {
    const latest = agentRows[agentRows.length - 1];
    const todays = agentRows.filter(r => dayOf(r) === today);
    let context_band: AgentState['context_band'] = null;
    if (latest.context_pct != null) {
      const pct = Number(latest.context_pct);
      context_band = pct >= 90 ? 'handover' : pct >= 75 ? 'warning' : 'nominal';
    }
    let minutes_since_step: number | null = null;
    if (latest.ts) {
      const t = Date.parse(latest.ts);
      if (Number.isFinite(t)) minutes_since_step = Math.max(0, Math.round((Date.now() - t) / 60000));
    }
    out.push({
      agent_name,
      run_id: latest.run_id as string,
      claude_session_id: (latest.claude_session_id as string) ?? null,
      model: (latest.model as string) ?? null,
      ticket_key: (latest.ticket_key as string) ?? null,
      phase: (latest.phase as string) ?? null,
      step: (latest.step as string) ?? null,
      context_pct: (latest.context_pct as number) ?? null,
      context_band,
      last_step_at: (latest.ts as string) ?? null,
      minutes_since_step,
      source: (latest.source as 'live' | 'backfill') ?? 'live',
      steps_logged: agentRows.length,
      today: summarise(todays),
    });
  }
  out.sort((a, b) => String(b.last_step_at || '').localeCompare(String(a.last_step_at || '')));
  return out;
}

export function runs(rows: Row[], { ticket_key, limit = 200 }: { ticket_key?: string; limit?: number } = {}): RunsPayload {
  const filtered = ticket_key ? rows.filter(r => r.ticket_key === ticket_key) : rows;
  const page = filtered.slice().reverse().slice(0, limit) as Step[];
  return { rows: page, total: filtered.length, truncated: filtered.length > page.length, malformed: 0, log_exists: true };
}

export function usage(rows: Row[], { days = 14 }: { days?: number } = {}): Usage {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const recent = rows.filter(r => (dayOf(r) || '') >= cutoff);
  const asList = (map: Map<string, Row[]>) => [...map.entries()].map(([key, rs]) => ({ key, ...summarise(rs) }));
  return {
    series: asList(groupBy(recent, dayOf) as Map<string, Row[]>).sort((a, b) => a.key.localeCompare(b.key)),
    byTicket: asList(groupBy(rows, r => r.ticket_key as string) as Map<string, Row[]>)
      .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0) || b.steps - a.steps),
    byAgent: asList(groupBy(rows, r => r.agent_name as string) as Map<string, Row[]>),
    byModel: asList(groupBy(rows, r => r.model as string) as Map<string, Row[]>),
    totals: summarise(rows),
    window_days: days,
  };
}

export function gates(rows: Row[], { ticket_key }: { ticket_key?: string } = {}): TicketGates[] {
  const withGate = rows.filter(r => r.gate && r.ticket_key);
  const keys = ticket_key ? [ticket_key] : [...new Set(withGate.map(r => r.ticket_key as string))];
  return keys.map(key => {
    const forTicket = withGate.filter(r => r.ticket_key === key);
    const allRows = rows.filter(r => r.ticket_key === key);
    const gateStates = GATE_ORDER.map(gate => {
      const hits = forTicket.filter(r => r.gate === gate);
      if (hits.length === 0) return { gate, verdict: 'pending' as const, recorded: false, ts: null, by: null, note: null };
      const latest = hits[hits.length - 1];
      return {
        gate, verdict: (latest.verdict as TicketGates['gates'][number]['verdict']) || 'pending',
        recorded: true, ts: (latest.ts as string) ?? null, by: (latest.agent_name as string) ?? null,
        note: (latest.note as string) ?? null, source: latest.source as 'live' | 'backfill',
      };
    });
    const blocking = gateStates.filter(g => g.verdict === 'bounced' || g.verdict === 'blocked');
    const latestWith = (k: keyof Row) => { const hit = [...allRows].reverse().find(r => r[k] != null); return hit ? (hit[k] as string) : null; };
    return {
      ticket_key: key, gates: gateStates,
      blocked: blocking.length > 0,
      blocking_gates: blocking.map(g => g.gate),
      ready_to_merge: gateStates.every(g => g.recorded && CLEARING_VERDICTS.includes(g.verdict)),
      pr_url: latestWith('pr_url'), ci_state: latestWith('ci_state'), solution_commit: latestWith('solution_commit'),
      steps: allRows.length, last_activity: allRows.length ? (allRows[allRows.length - 1].ts as string) : null,
    };
  }).sort((a, b) => String(a.ticket_key).localeCompare(String(b.ticket_key)));
}

export function gatePayload(rows: Row[], ticket_key?: string): GatesPayload {
  return { tickets: gates(rows, { ticket_key }), gate_order: [...GATE_ORDER] };
}
