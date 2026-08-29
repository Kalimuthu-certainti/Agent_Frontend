import { useCallback, useEffect, useState } from 'react';
import { loadRows, reset } from './data';
import { agents, gatePayload, runs, usage } from './reader';
import { GATE_ORDER } from './runlog';
import type { ApprovalsPayload, Config } from './types';

/**
 * No backend. This resolves what the old `/api/*` endpoints returned, but purely
 * in the browser from the run log the agent commits. Every surface stays
 * read-only — nothing here writes.
 */

export class ApiError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

function num(sp: URLSearchParams, key: string, fallback: number) {
  const n = Number.parseInt(sp.get(key) || '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Read-only approvals view: gates recorded as waiting on a human. No decisions
 *  exist without a backend, so `decision` is always null and `decided` is empty. */
function approvalsFromGates(rows: Parameters<typeof gatePayload>[0]): ApprovalsPayload {
  const { tickets } = gatePayload(rows);
  const items = [];
  for (const t of tickets) {
    for (const g of t.gates) {
      const waiting = g.recorded && (g.verdict === 'pending' || g.verdict === 'bounced' || g.verdict === 'escalated');
      if (!waiting) continue;
      items.push({
        request_id: `${t.ticket_key}:${g.gate}`,
        ticket_key: t.ticket_key, gate: g.gate, verdict: g.verdict,
        raised_at: g.ts, raised_by: g.by, note: g.note,
        pr_url: t.pr_url, ci_state: t.ci_state, solution_commit: t.solution_commit,
        blocked: t.blocked, blocking_gates: t.blocking_gates, ready_to_merge: t.ready_to_merge,
        decision: null,
      });
    }
  }
  return { items, decided: [], gate_order: [...GATE_ORDER] };
}

export async function getJson<T>(path: string): Promise<T> {
  const [p, qs] = path.split('?');
  const sp = new URLSearchParams(qs || '');
  const { rows, malformed } = await loadRows();

  switch (p) {
    case '/api/agents':
      return { agents: agents(rows), log_exists: rows.length > 0, malformed_lines: malformed, log_path: 'data/run-log.jsonl' } as T;
    case '/api/runs':
      return runs(rows, { ticket_key: sp.get('ticket_key') || undefined, limit: num(sp, 'limit', 200) }) as T;
    case '/api/usage':
      return usage(rows, { days: num(sp, 'days', 14) }) as T;
    case '/api/gates':
      return gatePayload(rows, sp.get('ticket_key') || undefined) as T;
    case '/api/approvals':
      return approvalsFromGates(rows) as T;
    case '/api/config':
      return { log_path: 'data/run-log.jsonl', jira_configured: false, jira_project: null, reader: 'StaticFileReader' } as Config as T;
    default:
      throw new ApiError(`no data for ${p}`, 'not_found');
  }
}

export interface Poll<T> { data: T | null; error: Error | null; loading: boolean; reload: () => void }

/** Load once from the static files. There is nothing to poll — the files change
 *  only on a redeploy — so `reload` re-fetches on demand instead. The second
 *  arg (a poll interval, in the old backend version) is accepted and ignored. */
export function usePoll<T>(path: string, _ms?: number): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setData(await getJson<T>(path)); setError(null); }
    catch (err) { setError(err as Error); }
    finally { setLoading(false); }
  }, [path]);

  useEffect(() => { let alive = true; if (alive) load(); return () => { alive = false; }; }, [load]);

  const reload = useCallback(() => { reset(); setLoading(true); load(); }, [load]);
  return { data, error, loading, reload };
}
