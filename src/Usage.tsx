import { Area, AreaChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart, Bar } from 'recharts';
import { usePoll } from './api';
import type { Bucket, Usage as UsageData } from './types';
import { Absent, EmptyState, ErrorState, Loading, Metric, money, Panel, compact } from './ui';

/* One measure per axis. Never a dual-axis chart: tokens and cost are separate
 * charts, because putting two scales on one plot is the single most misleading
 * thing a dashboard can do. */

const AXIS = { stroke: 'var(--ink-3)', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' };

function ChartFrame({ title, recorded, children, note }: {
  title: string; recorded: number; children: React.ReactNode; note?: string;
}) {
  return (
    <Panel title={title}>
      {recorded === 0
        ? <div style={{ height: 200, display: 'grid', placeItems: 'center', background: 'var(--absent-fill)',
            border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ textAlign: 'center' }}>
              <Absent>not recorded yet</Absent>
              <p className="hint" style={{ maxWidth: '42ch', marginTop: 'var(--s2)' }}>
                No step has carried this measure. A flat line at zero would be a lie, so the plot is
                withheld until there is something to plot.
              </p>
            </div>
          </div>
        : children}
      {note && <p className="hint" style={{ marginTop: 'var(--s3)' }}>{note}</p>}
    </Panel>
  );
}

function CostTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--surface-raise)', border: '1px solid var(--border-strong)',
      borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
      <div className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>{label}</div>
      <div className="mono">{payload[0].value === null ? 'not recorded' : money(payload[0].value)}</div>
    </div>
  );
}

export function Usage() {
  const { data, error, loading } = usePoll<UsageData>('/api/usage?days=14', 10000);
  if (error) return <ErrorState what="usage" error={error} />;
  if (loading || !data) return <Loading what="usage" />;

  const { series, byTicket, byAgent, byModel, totals } = data;
  if (totals.steps === 0) {
    return <EmptyState title="Nothing logged in this window">
      <p>Usage is derived from the run log. No steps, no usage.</p>
    </EmptyState>;
  }

  const costSeries = series.filter(s => s.cost_recorded > 0);
  const maxTicketCost = Math.max(0, ...byTicket.map(t => t.cost_usd ?? 0));

  return (
    <>
      <div className="strip" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="strip-cell">
          <div className="label">Steps logged</div>
          <div className="value">{totals.steps}</div>
          <div className="foot">all time</div>
        </div>
        <div className="strip-cell">
          <div className="label">Tokens</div>
          <div className="value" style={{ fontSize: totals.tokens_total === null ? '0.9rem' : undefined }}>
            {totals.tokens_total === null ? <Absent /> : compact(totals.tokens_total)}
          </div>
          <div className="foot">{totals.tokens_total_recorded} of {totals.steps * 2} fields recorded</div>
        </div>
        <div className="strip-cell">
          <div className="label">Total cost</div>
          <div className="value" style={{ fontSize: totals.cost_usd === null ? '0.9rem' : undefined }}>
            {totals.cost_usd === null ? <Absent /> : money(totals.cost_usd)}
          </div>
          <div className="foot">{totals.cost_recorded} of {totals.steps} steps recorded</div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 'var(--s4)' }}>
        <ChartFrame title={`Spend over the last ${data.window_days} days`} recorded={costSeries.length}
          note="Endpoint emphasised. One measure, one axis.">
          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={costSeries} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="key" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }}
                  tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52}
                  tickFormatter={(v: number) => '$' + v.toFixed(2)} />
                <Tooltip content={<CostTooltip />} cursor={{ stroke: 'var(--border-strong)' }} />
                <Area type="monotone" dataKey="cost_usd" stroke="var(--accent)" strokeWidth={2}
                  fill="url(#spendFill)" isAnimationActive={false}
                  dot={false} activeDot={{ r: 4 }} />
                <Area type="monotone" dataKey="cost_usd" stroke="none" fill="none" isAnimationActive={false}
                  dot={(p: any) => p.index === costSeries.length - 1
                    ? <circle key={p.index} cx={p.cx} cy={p.cy} r={5} fill="var(--accent)"
                        stroke="var(--surface)" strokeWidth={2} />
                    : <g key={p.index} />} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartFrame>

        <ChartFrame title="Cost per ticket" recorded={byTicket.filter(t => t.cost_recorded > 0).length}
          note="Sorted by spend, highest first.">
          <div style={{ height: Math.max(120, byTicket.length * 44) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byTicket} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }}
                  tickFormatter={(v: number) => '$' + v.toFixed(2)} />
                <YAxis type="category" dataKey="key" tick={AXIS} tickLine={false} axisLine={false} width={132} />
                <Tooltip content={<CostTooltip />} cursor={{ fill: 'var(--accent-glow)' }} />
                <Bar dataKey="cost_usd" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={18}>
                  {byTicket.map((t, i) => (
                    <Cell key={i} fill={(t.cost_usd ?? 0) >= maxTicketCost ? 'var(--accent)' : 'var(--accent-dim)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartFrame>

        <div style={{ display: 'grid', gap: 'var(--s4)', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
          <Split title="By agent" rows={byAgent} />
          <Split title="By model" rows={byModel} />
        </div>
      </div>
    </>
  );
}

function Split({ title, rows }: { title: string; rows: Bucket[] }) {
  return (
    <Panel title={title}>
      <div className="scroll-x">
        <table>
          <thead><tr><th>{title.replace('By ', '')}</th><th className="num">Steps</th><th className="num">Tokens</th><th className="num">Cost</th></tr></thead>
          <tbody>
            {rows.length === 0
              ? <tr><td colSpan={4}><Absent>nothing recorded</Absent></td></tr>
              : rows.map(r => (
                <tr key={r.key}>
                  <td className="mono">{r.key}</td>
                  <td className="num">{r.steps}</td>
                  <td className="num"><Metric value={r.tokens_total} recorded={r.tokens_total_recorded} format={compact} /></td>
                  <td className="num"><Metric value={r.cost_usd} recorded={r.cost_recorded} format={money} /></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
