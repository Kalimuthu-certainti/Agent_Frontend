import { usePoll } from './api';
import type { GatesPayload, RunsPayload } from './types';
import { Absent, EmptyState, ErrorState, GateStrip, Loading, MergeVerdict, Panel, when } from './ui';

function CiChip({ state }: { state: string | null }) {
  if (state === null) return <Absent>CI state not recorded</Absent>;
  if (state === 'no_checks') return <span className="chip warning">no CI checks ran on this PR</span>;
  if (state === 'success') return <span className="chip healthy">CI green</span>;
  if (state === 'failure') return <span className="chip critical">CI failing</span>;
  return <span className="chip">{state}</span>;
}

export function TicketView({ ticketKey, onPick }: { ticketKey: string | null; onPick: (k: string) => void }) {
  const gates = usePoll<GatesPayload>('/api/gates');
  // Fetch unfiltered and filter client-side against the ticket actually shown.
  // Querying by `ticketKey` would let the heading and the rows disagree whenever
  // the view falls back to the first ticket — wrong rows under a heading.
  const runs = usePoll<RunsPayload>('/api/runs?limit=500');

  if (gates.error) return <ErrorState what="ticket gates" error={gates.error} />;
  if (gates.loading || !gates.data) return <Loading what="tickets" />;

  const tickets = gates.data.tickets;
  if (tickets.length === 0) {
    return <EmptyState title="No ticket has a recorded gate">
      <p>A ticket appears here once a step is logged carrying a <code className="mono">gate</code> and a
        {' '}<code className="mono">verdict</code>. Nothing is assumed passed.</p>
    </EmptyState>;
  }

  const active = tickets.find(t => t.ticket_key === ticketKey) ?? tickets[0];

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', marginBottom: 'var(--s5)' }}>
        {tickets.map(t => (
          <button key={t.ticket_key} className="btn mono"
            onClick={() => onPick(t.ticket_key)}
            aria-pressed={t.ticket_key === active.ticket_key}
            style={t.ticket_key === active.ticket_key
              ? { borderColor: 'var(--accent)', background: 'var(--accent-dim)' } : undefined}>
            {t.ticket_key}
            {t.blocked && <span style={{ color: 'var(--critical)' }}> ●</span>}
          </button>
        ))}
      </div>

      {/* The gate strip is the hero of this surface. */}
      <Panel title={`${active.ticket_key} — gate progression`} aside={<MergeVerdict ticket={active} />}>
        <GateStrip ticket={active} />
        <div style={{ marginTop: 'var(--s4)', display: 'grid', gap: 'var(--s2)' }}>
          {active.gates.filter(g => g.recorded && g.note).map(g => (
            <p key={g.gate} style={{ margin: 0, fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>
              <strong className="mono">{g.gate}</strong> — {g.note}
              {g.by && <span style={{ color: 'var(--ink-3)' }}> · {g.by} · {when(g.ts)}</span>}
            </p>
          ))}
        </div>
      </Panel>

      <div style={{ display: 'grid', gap: 'var(--s4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', margin: 'var(--s4) 0' }}>
        <Panel title="Pull request">
          {active.pr_url
            ? <><a href={active.pr_url} target="_blank" rel="noreferrer" className="mono"
                style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{active.pr_url}</a>
              <p style={{ marginTop: 'var(--s3)' }}><CiChip state={active.ci_state} /></p></>
            : <Absent>no PR recorded for this ticket</Absent>}
        </Panel>
        <Panel title="Approved solution">
          {active.solution_commit
            ? <><div className="mono" style={{ wordBreak: 'break-all', fontSize: 'var(--t-sm)' }}>{active.solution_commit}</div>
              <p className="hint">the commit the approval was pinned to</p></>
            : <Absent>no approved solution commit recorded</Absent>}
        </Panel>
        <Panel title="QA evidence">
          <Absent>no evidence artefacts recorded on any step</Absent>
          <p className="hint">Evidence appears when a step logs artefact paths. The run log carries no
            evidence fields yet, so nothing is shown rather than a placeholder gallery.</p>
        </Panel>
      </div>

      <Panel title="Step timeline" aside={<span className="hint">{active.steps} steps</span>}>
        {runs.error ? <ErrorState what="the timeline" error={runs.error} />
          : !runs.data ? <Loading what="steps" />
          : (() => {
            const rows = runs.data.rows.filter(r => r.ticket_key === active.ticket_key);
            return rows.length === 0 ? <Absent>no steps recorded for this ticket</Absent>
          : <div className="scroll-x"><table>
              <thead><tr><th>When</th><th>Agent</th><th>Phase</th><th>Step</th><th>Gate</th><th className="num">Cost</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.ts}-${i}`} className="rowin">
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{when(r.ts)}</td>
                    <td>{r.agent_name}</td>
                    <td>{r.phase ?? <Absent>—</Absent>}</td>
                    <td>{r.step ?? <Absent>—</Absent>}</td>
                    <td className="mono">{r.gate ? `${r.gate} ${r.verdict ?? ''}` : ''}</td>
                    <td className="num">{r.cost_usd === null ? <Absent>—</Absent> : '$' + r.cost_usd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>;
          })()}
      </Panel>
    </>
  );
}
