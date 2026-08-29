import { usePoll } from './api';
import type { ApprovalItem, ApprovalsPayload } from './types';
import { Absent, EmptyState, ErrorState, Loading, when } from './ui';

/* Read-only. With no backend there are no decision buttons — this shows what the
 * agent has recorded as waiting on a human (a pending/bounced/escalated gate),
 * with enough context to see why. Decisions happen over email, not here. */

function Item({ item }: { item: ApprovalItem }) {
  return (
    <article className="panel" style={{ marginBottom: 'var(--s4)' }}>
      <header className="panel-head">
        <h2 className="mono" style={{ fontFamily: 'var(--mono)' }}>{item.ticket_key}</h2>
        <span className="chip">{item.gate}</span>
        <span className={`chip ${item.verdict === 'bounced' || item.verdict === 'blocked' ? 'critical' : 'warning'}`}>{item.verdict}</span>
        {item.blocked && <span className="chip critical">blocked</span>}
        <span className="grow" />
        <span className="hint">{item.raised_at ? when(item.raised_at) : <Absent>no timestamp</Absent>}</span>
      </header>
      <div className="panel-body">
        {item.note && <p style={{ marginTop: 0 }}>{item.note}</p>}
        <dl className="tile-meta" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
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
      </div>
    </article>
  );
}

export function Approvals() {
  const { data, error, loading } = usePoll<ApprovalsPayload>('/api/approvals');
  if (error) return <ErrorState what="the approvals view" error={error} />;
  if (loading || !data) return <Loading what="approvals" />;

  const pending = data.items;
  if (pending.length === 0) {
    return (
      <EmptyState title="Nothing is waiting on a human">
        <p>Every gate the agent has recorded is either cleared or not yet reached. Approvals are
          decided over email; this view only reflects what the run log records.</p>
      </EmptyState>
    );
  }
  return (
    <>
      <h2 style={{ fontSize: 'var(--t-h2)', marginBottom: 'var(--s3)' }}>Waiting on a human · {pending.length}</h2>
      {pending.map(i => <Item key={i.request_id} item={i} />)}
    </>
  );
}
