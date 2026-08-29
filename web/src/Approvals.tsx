import { useState } from 'react';
import { ApiError, postJson, usePoll } from './api';
import type { ApprovalItem, ApprovalRecord, ApprovalsPayload } from './types';
import { Absent, EmptyState, ErrorState, Loading, Panel, when } from './ui';

/** The decision of record, once one exists. Shown instead of the buttons —
 *  the brief: "if a decision already exists, show it rather than allowing a
 *  conflicting second one." */
function Decided({ record }: { record: ApprovalRecord }) {
  const clear = record.decision === 'approved';
  return (
    <div style={{
      border: `1px solid var(--${clear ? 'healthy' : 'critical'})`,
      background: `var(--${clear ? 'healthy' : 'critical'}-dim)`,
      borderRadius: 'var(--radius-sm)', padding: 'var(--s3)',
    }}>
      <div style={{ fontWeight: 600, color: `var(--${clear ? 'healthy' : 'critical'})` }}>
        {clear ? '✓ Approved' : '✕ Bounced'} by {record.actor}
      </div>
      <div className="hint">{when(record.ts)} · via {record.channel}</div>
      {record.reason && <p style={{ margin: 'var(--s2) 0 0', fontSize: 'var(--t-sm)' }}>{record.reason}</p>}
    </div>
  );
}

function Item({ item, actor, onDone }: { item: ApprovalItem; actor: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<null | 'approved' | 'bounced'>(null);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ApprovalRecord | null>(null);

  async function decide(decision: 'approved' | 'bounced') {
    setErr(null); setConflict(null); setBusy(decision);
    try {
      await postJson('/api/approvals', {
        request_id: item.request_id, ticket_key: item.ticket_key, gate: item.gate,
        decision, reason: reason.trim() || null, actor,
      });
      onDone();
    } catch (e) {
      const api = e as ApiError;
      if (api.code === 'CONFLICT' && api.payload?.existing) setConflict(api.payload.existing);
      else setErr(api.message);
    } finally { setBusy(null); }
  }

  const needsReason = !reason.trim();
  const noActor = !actor.trim();

  return (
    <article className="panel rowin" style={{ marginBottom: 'var(--s4)' }}>
      <header className="panel-head">
        <h2 className="mono" style={{ fontFamily: 'var(--mono)' }}>{item.ticket_key}</h2>
        <span className="chip">{item.gate}</span>
        {item.blocked && <span className="chip critical">blocked</span>}
        <span className="grow" />
        <span className="hint">{item.raised_at ? when(item.raised_at) : <Absent>no timestamp</Absent>}</span>
      </header>
      <div className="panel-body">
        {item.note && <p style={{ marginTop: 0 }}>{item.note}</p>}

        <dl className="tile-meta" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
          <dt>verdict</dt><dd>{item.verdict}</dd>
          <dt>routed to</dt>
          <dd>{item.routing
            ? `${item.routing.group_name} · ${item.routing.recipient_count} recipient${
                item.routing.recipient_count === 1 ? '' : 's'}${item.routing.via === 'dl' ? ' (via DL)' : ''}`
            : <Absent>no group owns this gate — assign one on the Team screen</Absent>}</dd>
          <dt>raised by</dt><dd>{item.raised_by ?? <Absent />}</dd>
          <dt>PR</dt>
          <dd>{item.pr_url
            ? <a href={item.pr_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                {item.pr_url.split('/').slice(-3).join('/')}</a>
            : <Absent />}</dd>
          <dt>CI</dt>
          <dd>{item.ci_state === null ? <Absent />
            : item.ci_state === 'no_checks' ? <span style={{ color: 'var(--warning)' }}>no checks ran</span>
            : item.ci_state}</dd>
          <dt>solution</dt>
          <dd>{item.solution_commit ? item.solution_commit.slice(0, 12) : <Absent />}</dd>
          <dt>merge state</dt>
          <dd>{item.ready_to_merge ? 'all gates clear'
            : item.blocking_gates.length ? `blocked at ${item.blocking_gates.join(', ')}`
            : 'gates incomplete'}</dd>
        </dl>

        {item.decision ? (
          <div style={{ marginTop: 'var(--s4)' }}><Decided record={item.decision} /></div>
        ) : conflict ? (
          <div style={{ marginTop: 'var(--s4)' }}>
            <p style={{ color: 'var(--warning)', fontSize: 'var(--t-sm)' }}>
              Someone decided this while you were looking at it. Their decision stands.
            </p>
            <Decided record={conflict} />
          </div>
        ) : (
          <div style={{ marginTop: 'var(--s4)' }}>
            <div className="field">
              <label htmlFor={`r-${item.request_id}`}>Reason <span className="hint">(required to bounce)</span></label>
              <textarea id={`r-${item.request_id}`} rows={2} value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="What must change, and why" />
            </div>
            {err && <p style={{ color: 'var(--critical)', fontSize: 'var(--t-sm)' }}>{err}</p>}
            <div style={{ display: 'flex', gap: 'var(--s2)' }}>
              <button className="btn btn-primary" disabled={busy !== null || noActor}
                onClick={() => decide('approved')}
                title={noActor ? 'Set your name first — an approval needs an actor' : undefined}>
                {busy === 'approved' ? 'Recording…' : `Approve ${item.gate}`}
              </button>
              <button className="btn btn-danger" disabled={busy !== null || needsReason || noActor}
                onClick={() => decide('bounced')}
                title={noActor ? 'Set your name first' : needsReason ? 'A bounce needs a reason' : undefined}>
                {busy === 'bounced' ? 'Recording…' : 'Bounce'}
              </button>
            </div>
            {noActor
              ? <p className="hint">Both actions are disabled until you set your name above.</p>
              : needsReason && <p className="hint">Bounce is disabled until you give a reason — whoever
                  picks this up needs to know what to change.</p>}
          </div>
        )}
      </div>
    </article>
  );
}

export function Approvals() {
  const { data, error, loading, reload } = usePoll<ApprovalsPayload>('/api/approvals');
  const [actor, setActor] = useState(() => localStorage.getItem('acp.actor') ?? '');

  if (error) return <ErrorState what="the approvals queue" error={error} />;
  if (loading || !data) return <Loading what="approvals" />;

  const pending = data.items.filter(i => !i.decision);
  const settled = data.items.filter(i => i.decision);

  return (
    <>
      <Panel title="Who is deciding">
        <div className="field" style={{ maxWidth: 360, marginBottom: 0 }}>
          <label htmlFor="actor">Your name — recorded on every decision</label>
          <input id="actor" value={actor} placeholder="e.g. alex"
            onChange={e => { setActor(e.target.value); localStorage.setItem('acp.actor', e.target.value); }} />
          <p className="hint">An approval with no name is not an audit record, so the buttons stay disabled
            until this is set. It is stored in this browser only.</p>
        </div>
      </Panel>

      <div style={{ marginTop: 'var(--s5)' }}>
        {pending.length === 0 ? (
          <EmptyState title="Nothing is waiting on you">
            <p>Every gate that has been recorded is either cleared or already decided. This is the state
              you want to see — it is not an error and nothing is hidden behind it.</p>
          </EmptyState>
        ) : (
          <>
            <h2 style={{ fontSize: 'var(--t-h2)', marginBottom: 'var(--s3)' }}>
              Waiting on you · {pending.length}
            </h2>
            {!actor.trim() && (
              <p style={{ color: 'var(--warning)', fontSize: 'var(--t-sm)' }}>
                Enter your name above to enable the decision buttons.
              </p>
            )}
            {pending.map(i => (
              <Item key={i.request_id} item={i} actor={actor.trim()}
                onDone={reload} />
            ))}
          </>
        )}

        {settled.length > 0 && (
          <>
            <h2 style={{ fontSize: 'var(--t-h2)', margin: 'var(--s6) 0 var(--s3)' }}>
              Already decided · {settled.length}
            </h2>
            {settled.map(i => <Item key={i.request_id} item={i} actor={actor.trim()} onDone={reload} />)}
          </>
        )}
      </div>
    </>
  );
}
