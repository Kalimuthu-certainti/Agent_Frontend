import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  code: string; payload: any;
  constructor(message: string, code: string, payload?: any) {
    super(message); this.code = code; this.payload = payload;
  }
}

/** Static-demo mode (GitHub Pages): there is no backend, so reads come from a
 *  bundled synthetic snapshot and writes are refused with an honest message
 *  rather than a network error. Set VITE_STATIC=1 at build time. */
export const STATIC_DEMO = import.meta.env.VITE_STATIC === '1';

export async function getJson<T>(path: string): Promise<T> {
  if (STATIC_DEMO) {
    const { DEMO } = await import('./demoData');
    if (path in DEMO) return DEMO[path] as T;
    // tolerate query-string variants the UI builds at runtime
    const base = path.split('&')[0];
    const hit = Object.keys(DEMO).find(k => k === base || k.startsWith(path.split('?')[0] + '?'));
    if (hit) return DEMO[hit] as T;
    throw new ApiError(`no snapshot for ${path}`, 'not_found');
  }
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? `HTTP ${res.status}`, body?.error ?? 'http_error', body);
  return body as T;
}

async function writeJson<T>(method: 'POST' | 'PATCH', path: string, payload: unknown): Promise<T> {
  if (STATIC_DEMO) {
    throw new ApiError(
      'This is a read-only demo hosted on GitHub Pages. Changes need the backend, which is not ' +
      'connected here — run the full app (npm start) to record them.',
      'static_demo');
  }
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? `HTTP ${res.status}`, body?.error ?? 'http_error', body);
  return body as T;
}

export const postJson = <T>(path: string, payload: unknown) => writeJson<T>('POST', path, payload);
export const patchJson = <T>(path: string, payload: unknown) => writeJson<T>('PATCH', path, payload);

export interface Poll<T> { data: T | null; error: Error | null; loading: boolean; reload: () => void }

/** Poll an endpoint. `loading` is only true on the FIRST load — a refresh must
 *  never blank a populated screen the operator is reading. */
export function usePoll<T>(path: string, ms = 5000): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setData(await getJson<T>(path)); setError(null); }
    catch (err) { setError(err as Error); }
    finally { setLoading(false); }
  }, [path]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) load(); };
    tick();
    // A static snapshot never changes — don't poll it.
    if (STATIC_DEMO) return () => { alive = false; };
    const id = setInterval(tick, ms);
    return () => { alive = false; clearInterval(id); };
  }, [load, ms]);

  return { data, error, loading, reload: load };
}
