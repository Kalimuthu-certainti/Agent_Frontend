/**
 * The data layer — the agent's committed files, fetched statically. No backend.
 *
 *   public/data/run-log.jsonl   the agent's work (one JSON step per line)
 *   public/data/team.md         mail routing, edited in Markdown by the agent
 *
 * Both are served next to the built app (under BASE_URL/data/…), so this works
 * on GitHub Pages with nothing running server-side.
 */

import { parseRunLog, type Row } from './reader';

const base = import.meta.env.BASE_URL; // '/Agent_Frontend/' on Pages, '/' elsewhere

async function fetchText(rel: string): Promise<string> {
  const res = await fetch(base + rel, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`could not load ${rel} — HTTP ${res.status}`);
  return res.text();
}

let rowsPromise: Promise<{ rows: Row[]; malformed: number }> | null = null;
let teamPromise: Promise<string> | null = null;

export function loadRows() {
  if (!rowsPromise) {
    rowsPromise = fetchText('data/run-log.jsonl')
      .then(parseRunLog)
      // A missing/empty log is an empty dashboard, not an error.
      .catch(() => ({ rows: [], malformed: 0 }));
  }
  return rowsPromise;
}

export function loadTeamMd() {
  if (!teamPromise) teamPromise = fetchText('data/team.md');
  return teamPromise;
}

/** Force a re-fetch on next access (used by a manual refresh). */
export function reset() { rowsPromise = null; teamPromise = null; }

export const DATA_BASE = base + 'data';
