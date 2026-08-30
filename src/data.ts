/**
 * The data layer — the agent's committed files, fetched statically. No backend.
 *
 *   public/data/run-log.jsonl   the agent's work (one JSON step per line)
 *   public/data/team.json       mail routing — the source of truth
 *   public/data/team.md         prose notes about the rota, rendered beside it
 *
 * Both are served next to the built app (under BASE_URL/data/…), so this works
 * on GitHub Pages with nothing running server-side.
 */

import { parseRunLog, type Row } from './reader';
import type { TeamConfig } from './types';

const base = import.meta.env.BASE_URL; // '/Agent_Frontend/' on Pages, '/' elsewhere

async function fetchText(rel: string): Promise<string> {
  const res = await fetch(base + rel, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`could not load ${rel} — HTTP ${res.status}`);
  return res.text();
}

let rowsPromise: Promise<{ rows: Row[]; malformed: number }> | null = null;
let teamPromise: Promise<string> | null = null;
let teamJsonPromise: Promise<TeamConfig> | null = null;

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

/** The routing. This is the file the agent and the mailer read. */
export function loadTeamJson(): Promise<TeamConfig> {
  if (!teamJsonPromise) teamJsonPromise = fetchText('data/team.json').then(t => JSON.parse(t) as TeamConfig);
  return teamJsonPromise;
}

/** Force a re-fetch on next access (used by a manual refresh). */
export function reset() { rowsPromise = null; teamPromise = null; teamJsonPromise = null; }

export const DATA_BASE = base + 'data';
