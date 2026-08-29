import type { ReactNode } from 'react';
import type { GateState, Summary, TicketGates } from './types';

/* ---------------------------------------------------------------------------
 * The no-fake-data rule, enforced as a component.
 *
 * `Absent` is the ONLY way a missing value reaches the screen, and `Metric` is
 * the only way a number does. Nothing renders 0 for a value nobody recorded.
 * ------------------------------------------------------------------------- */

export function Absent({ children = 'not recorded yet' }: { children?: ReactNode }) {
  return <span className="absent">{children}</span>;
}

export function Metric({ value, recorded, format = (n: number) => n.toLocaleString() }: {
  value: number | null; recorded: number; format?: (n: number) => string;
}) {
  if (value === null || recorded === 0) return <Absent />;
  return <span className="mono">{format(value)}</span>;
}

export const money = (n: number) => '$' + n.toFixed(2);
export const compact = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

export const when = (ts: string | null) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
};

export const ago = (mins: number | null) => {
  if (mins === null) return null;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/* ---------- shells ---------- */

export function Panel({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {title && (
        <header className="panel-head">
          <h2>{title}</h2>
          <span className="grow" />
          {aside}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="state"><h3>{title}</h3>{children}</div>;
}

export function ErrorState({ what, error }: { what: string; error: Error }) {
  return (
    <div className="state is-error">
      <h3>Could not load {what}</h3>
      <p>{error.message}</p>
      <p>The API serves <code className="mono">/api</code> on this host. If it is not running:
        {' '}<code className="mono">node src/server.js</code></p>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="state"><h3>Loading {what}…</h3></div>;
}

/* ---------- context ring ----------
 * The primary visual on a tile. Encodes band by colour AND by arc weight, and
 * always states the band in words, so it reads without hue. */

export function ContextRing({ pct, band, size = 96 }: {
  pct: number | null; band: 'nominal' | 'warning' | 'handover' | null; size?: number;
}) {
  const stroke = band === 'handover' ? 10 : band === 'warning' ? 8 : 6;
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  const colour = band === 'handover' ? 'var(--critical)'
    : band === 'warning' ? 'var(--warning)' : 'var(--healthy)';
  const label = band === 'handover' ? 'handing over'
    : band === 'warning' ? 'finishing current piece' : 'nominal';

  if (pct === null) {
    return (
      <div className="ring-wrap">
        <svg width={size} height={size} role="img" aria-label="context usage not recorded yet">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-strong)"
            strokeWidth={6} strokeDasharray="4 6" opacity={0.7} />
        </svg>
        <div className="cap">context</div>
        <div className="band"><Absent /></div>
      </div>
    );
  }

  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="ring-wrap">
      <svg width={size} height={size} role="img"
        aria-label={`context usage ${p} percent, ${label}; thresholds at 75 and 90 percent`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-sunk)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colour} strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={`${(p / 100) * c} ${c}`} />
          {[75, 90].map(t => {
            const a = (t / 100) * 2 * Math.PI;
            const inner = r - stroke / 2 - 2, outer = r + stroke / 2 + 2;
            const cx = size / 2, cy = size / 2;
            return <line key={t} x1={cx + inner * Math.cos(a)} y1={cy + inner * Math.sin(a)}
              x2={cx + outer * Math.cos(a)} y2={cy + outer * Math.sin(a)}
              stroke="var(--ink-3)" strokeWidth={2} />;
          })}
        </g>
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
          className="ring-num" fontSize={size / 4} fill="var(--ink)">{p}%</text>
      </svg>
      <div className="cap">context</div>
      <div className="band" style={{ color: colour }}>{label}</div>
    </div>
  );
}

/* ---------- gate strip ---------- */

const GLYPH: Record<string, string> = {
  pass: '✓', approved: '✓', bounced: '✕', blocked: '✕', escalated: '↑', pending: '·',
};

export function gateClass(g: GateState) {
  if (!g.recorded) return 's-unrecorded';
  if (g.verdict === 'pass' || g.verdict === 'approved') return 's-clear';
  if (g.verdict === 'bounced' || g.verdict === 'blocked') return 's-blocked';
  return 's-waiting';
}

export function GateStrip({ ticket }: { ticket: TicketGates }) {
  return (
    <div className="gatestrip" role="list" aria-label={`gate progression for ${ticket.ticket_key}`}>
      {ticket.gates.map(g => (
        <div key={g.gate} role="listitem" className={`gate ${gateClass(g)}`}
          title={g.note ?? (g.ts ? `${g.verdict} at ${when(g.ts)}` : 'no record')}>
          <span className="g-name">{g.gate}</span>
          <span className="g-verdict">
            <span aria-hidden="true" className="mono">{g.recorded ? GLYPH[g.verdict] ?? '·' : '·'}</span>
            {g.recorded ? g.verdict : 'not recorded'}
          </span>
          <span className="g-meta">{g.recorded && g.ts ? when(g.ts)!.slice(5, 16) : '—'}</span>
        </div>
      ))}
    </div>
  );
}

/** The honest merge verdict. Never "ready" on assumption. */
export function MergeVerdict({ ticket }: { ticket: TicketGates }) {
  if (ticket.blocked) {
    return <span className="chip critical">blocked at {ticket.blocking_gates.join(', ')}</span>;
  }
  if (ticket.ready_to_merge) {
    return <span className="chip healthy">✓ all gates recorded and clear</span>;
  }
  const missing = ticket.gates.filter(g => !g.recorded).length;
  return <span className="chip dashed">{missing} gate{missing === 1 ? '' : 's'} not recorded — not ready to merge</span>;
}

export function TokensCell({ s }: { s: Summary }) {
  if (s.tokens_total_recorded === 0) return <Absent />;
  return <span className="mono">{compact(s.tokens_total ?? 0)}</span>;
}
