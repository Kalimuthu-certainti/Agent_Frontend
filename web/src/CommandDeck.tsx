import { usePoll } from './api';
import type { AgentsPayload, ApprovalsPayload, GatesPayload } from './types';
import { Absent, ago, ContextRing, EmptyState, ErrorState, Loading, Metric, money, when } from './ui';

/** Four numbers, and the brief is explicit: resist adding a fifth. */
function StatusStrip({ agents, gates, approvals }: {
  agents: AgentsPayload; gates: GatesPayload | null; approvals: ApprovalsPayload | null;
}) {
  const inFlight = agents.agents.filter(a => a.minutes_since_step !== null && a.minutes_since_step < 90).length;
  const blocked = gates?.tickets.filter(t => t.blocked).length ?? null;
  const waiting = approvals?.items.filter(i => !i.decision).length ?? null;

  const costRecorded = agents.agents.reduce((n, a) => n + a.today.cost_recorded, 0);
  const costToday = costRecorded === 0 ? null
    : agents.agents.reduce((n, a) => n + (a.today.cost_usd ?? 0), 0);

  return (
    <div className="strip">
      <div className="strip-cell">
        <div className="label">In flight</div>
        <div className="value">{inFlight}</div>
        <div className="foot">of {agents.agents.length} agent{agents.agents.length === 1 ? '' : 's'} logged</div>
      </div>
      <div className="strip-cell">
        <div className="label">Blocked</div>
        <div className={`value${blocked ? ' is-critical' : ''}`}>{blocked === null ? '—' : blocked}</div>
        <div className="foot">tickets held at a gate</div>
      </div>
      <div className="strip-cell">
        <div className="label">Awaiting you</div>
        <div className={`value${waiting ? ' is-warning' : ''}`}>{waiting === null ? '—' : waiting}</div>
        <div className="foot">undecided approvals</div>
      </div>
      <div className="strip-cell">
        <div className="label">Spend today</div>
        <div className="value">
          {costToday === null ? <span style={{ fontSize: '0.9rem' }}><Absent /></span> : money(costToday)}
        </div>
        <div className="foot">
          {costToday === null ? 'no cost recorded on any step' : 'against no configured budget'}
        </div>
      </div>
    </div>
  );
}

export function CommandDeck({ onOpenTicket }: { onOpenTicket: (k: string) => void }) {
  const agents = usePoll<AgentsPayload>('/api/agents');
  const gates = usePoll<GatesPayload>('/api/gates');
  const approvals = usePoll<ApprovalsPayload>('/api/approvals');

  if (agents.error) return <ErrorState what="the command deck" error={agents.error} />;
  if (agents.loading || !agents.data) return <Loading what="agents" />;

  const { agents: list, malformed_lines, log_path } = agents.data;

  return (
    <>
      <StatusStrip agents={agents.data} gates={gates.data} approvals={approvals.data} />

      {malformed_lines > 0 && (
        <div className="state is-error" style={{ marginBottom: 'var(--s5)', padding: 'var(--s4)' }}>
          <h3>{malformed_lines} unreadable line{malformed_lines === 1 ? '' : 's'} in the run log</h3>
          <p>They were skipped, so every figure on this page may be short. The log is at
            {' '}<code className="mono">{log_path}</code>.</p>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState title="No agent has logged a step">
          <p>This deck shows only what the run log contains. Until an agent appends a step there is
            genuinely nothing to show — so rather than an empty dashboard, here is how one starts.</p>
          <pre>{`const { appendStep } = require('./src/runLog');

appendStep({
  run_id: 'r-8823',
  agent_name: 'A',
  claude_session_id: 'sess_01ab',
  model: 'claude-opus-5',
  ticket_key: 'APP-142',
  phase: 'build',
  step: 'implement calculator fix',
  tokens_in: 18400, tokens_out: 2100,
  cost_usd: 0.42, context_pct: 63,
});`}</pre>
          <p style={{ marginTop: 'var(--s3)' }}>Omit anything you cannot measure. It is stored as
            <code className="mono"> null</code> and shown as “not recorded yet”.</p>
        </EmptyState>
      ) : (
        <div className="deck">
          {list.map(a => {
            const live = a.minutes_since_step !== null && a.minutes_since_step < 90;
            const cls = a.context_band === 'handover' ? 'is-handover'
              : a.context_band === 'warning' ? 'is-warning' : live ? 'is-live' : '';
            const stale = a.minutes_since_step !== null && a.minutes_since_step > 60;
            return (
              <article key={a.agent_name} className={`tile ${cls}`}>
                <div className="tile-top">
                  <div className="tile-id">
                    <div className="name">
                      {live && <span className="livedot pulse" aria-hidden="true" />}
                      Agent {a.agent_name}
                    </div>
                    {a.ticket_key ? (
                      <button className="ticket mono" onClick={() => onOpenTicket(a.ticket_key!)}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)' }}>
                        {a.ticket_key} →
                      </button>
                    ) : <div className="ticket"><Absent>no ticket recorded</Absent></div>}
                    <div className="phase">{a.phase ?? <Absent>phase not recorded</Absent>}</div>
                    <div className="step">{a.step ?? <Absent>step not recorded</Absent>}</div>
                  </div>
                  <ContextRing pct={a.context_pct} band={a.context_band} />
                </div>

                <dl className="tile-meta">
                  <dt>session</dt><dd>{a.claude_session_id ?? <Absent />}</dd>
                  <dt>model</dt><dd>{a.model ?? <Absent />}</dd>
                  <dt>tokens today</dt>
                  <dd>
                    {a.today.tokens_total_recorded === 0 ? <Absent /> : <>
                      <Metric value={a.today.tokens_in} recorded={a.today.tokens_in_recorded} /> in
                      {' / '}
                      <Metric value={a.today.tokens_out} recorded={a.today.tokens_out_recorded} /> out
                    </>}
                  </dd>
                  <dt>spend today</dt>
                  <dd><Metric value={a.today.cost_usd} recorded={a.today.cost_recorded} format={money} /></dd>
                  <dt>last step</dt>
                  <dd style={stale ? { color: 'var(--warning)' } : undefined}>
                    {a.last_step_at ? `${ago(a.minutes_since_step)}` : <Absent />}
                    {stale && ' · checkpoint overdue'}
                  </dd>
                </dl>

                {a.source === 'backfill' && (
                  <p style={{ margin: 'var(--s3) 0 0' }}>
                    <span className="chip dashed">backfilled — not measured live</span>
                  </p>
                )}
                {a.last_step_at && (
                  <p className="hint" style={{ marginTop: 'var(--s2)' }}>{when(a.last_step_at)}</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
