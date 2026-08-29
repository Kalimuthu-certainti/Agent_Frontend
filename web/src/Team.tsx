import { useState } from 'react';
import { ApiError, STATIC_DEMO, patchJson, postJson, usePoll } from './api';
import type { EscalationRung, Group, Person, TeamState } from './types';
import { Absent, EmptyState, ErrorState, Loading, Panel } from './ui';

/* The surface that decides WHO gets an approval request for each gate. The
 * Mailer reads only this — so changing a recipient is done here, not in code.
 * A gate with no group renders a loud warning rather than a silent empty state:
 * an unrouted approval request goes nowhere. */

function DemoNote() {
  if (!STATIC_DEMO) return null;
  return (
    <div role="note" style={{
      border: '1px solid var(--warning)', background: 'var(--warning-dim)',
      borderRadius: 'var(--radius-sm)', padding: 'var(--s2) var(--s3)', marginBottom: 'var(--s4)',
      fontSize: 'var(--t-sm)',
    }}>
      Read-only demo — editing is disabled here. Run the full app (<span className="mono">npm start</span>)
      to add people, form groups and route mail for real.
    </div>
  );
}

function CoverageStrip({ state }: { state: TeamState }) {
  const nameFor = (gid: string | null) => state.groups.find(g => g.id === gid)?.name ?? null;
  return (
    <div className="gatestrip" role="list" aria-label="gate coverage" style={{ marginBottom: 'var(--s3)' }}>
      {state.routable_gates.map(gate => {
        const owner = state.coverage[gate];
        const starved = state.starved_gates.includes(gate);
        const cls = !owner ? 's-blocked' : starved ? 's-waiting' : 's-clear';
        return (
          <div key={gate} role="listitem" className={`gate ${cls}`}
            title={!owner ? 'no group owns this gate — approval requests go nowhere'
              : starved ? 'the owning group has no active member to mail'
              : `routed to ${nameFor(owner)}`}>
            <span className="g-name">{gate}</span>
            <span className="g-verdict">{owner
              ? (starved ? 'no active member' : nameFor(owner))
              : 'unassigned'}</span>
          </div>
        );
      })}
    </div>
  );
}

function AddPerson({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setErr(null); setBusy(true);
    try {
      await postJson('/api/team/person', { name: name.trim(), email: email.trim() });
      setName(''); setEmail(''); setOpen(false); onDone();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }

  if (!open) {
    return <button className="btn" disabled={STATIC_DEMO} onClick={() => setOpen(true)}>+ Add person</button>;
  }
  return (
    <div className="panel rowin" style={{ padding: 'var(--s3)', marginTop: 'var(--s2)' }}>
      <div className="field"><label>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" /></div>
      <div className="field"><label>Email</label>
        <input value={email} type="email" onChange={e => setEmail(e.target.value)} placeholder="name@certainti.ai" /></div>
      {err && <p style={{ color: 'var(--critical)', fontSize: 'var(--t-sm)' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 'var(--s2)' }}>
        <button className="btn btn-primary" disabled={busy || !name.trim() || !email.trim()} onClick={save}>
          {busy ? 'Adding…' : 'Add'}</button>
        <button className="btn" onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
      </div>
    </div>
  );
}

function PersonRow({ person, onChange }: { person: Person; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try { await patchJson(`/api/team/person/${person.id}`, { active: !person.active }); onChange(); }
    catch { /* surfaced on next load */ } finally { setBusy(false); }
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--s2)', padding: 'var(--s2) 0',
      borderTop: '1px solid var(--border)', opacity: person.active ? 1 : 0.55,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{person.name}</div>
        <div className="hint mono" style={{ wordBreak: 'break-all' }}>{person.email}</div>
      </div>
      <span className={`chip ${person.active ? 'healthy' : 'dashed'}`}>{person.active ? 'active' : 'inactive'}</span>
      <button className="btn" disabled={STATIC_DEMO || busy} onClick={toggle}
        title={person.active ? 'Deactivate — stops mailing them' : 'Reactivate'}>
        {person.active ? 'Deactivate' : 'Activate'}
      </button>
    </div>
  );
}

function GroupEditor({ group, state, onDone, onCancel }: {
  group: Group | null; state: TeamState; onDone: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [type, setType] = useState(group?.type ?? 'dev');
  const [gate, setGate] = useState<string>(group?.owns_gate ?? '');
  const [dl, setDl] = useState(group?.group_email ?? '');
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const [mode, setMode] = useState(group?.approval_mode ?? 'active-review');
  const [esc, setEsc] = useState<EscalationRung[]>(group?.escalation_order ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSecurity = type === 'security' || gate === 'RG-Sec';
  const takenGates = new Set(state.groups.filter(g => g.id !== group?.id && g.owns_gate).map(g => g.owns_gate));

  function toggleMember(id: string) {
    setMembers(m => m.includes(id) ? m.filter(x => x !== id) : [...m, id]);
    setEsc(e => e.filter(r => members.includes(r.person_id) || r.person_id === id));
  }
  function setRung(id: string, hours: string) {
    const t = Number(hours);
    setEsc(e => {
      const without = e.filter(r => r.person_id !== id);
      return hours === '' ? without : [...without, { person_id: id, timeout_hours: t }];
    });
  }

  async function save() {
    setErr(null); setBusy(true);
    const payload = {
      name: name.trim(), type, owns_gate: gate || null, group_email: dl.trim() || null,
      members, approval_mode: isSecurity ? 'active-review' : mode,
      escalation_order: esc.filter(r => members.includes(r.person_id)),
    };
    try {
      if (group) await patchJson(`/api/team/group/${group.id}`, payload);
      else await postJson('/api/team/group', payload);
      onDone();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }

  const person = (id: string) => state.people.find(p => p.id === id);

  return (
    <div className="panel rowin" style={{ padding: 'var(--s4)', marginBottom: 'var(--s3)' }}>
      <div className="field"><label>Group name</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Developers" /></div>

      <div style={{ display: 'flex', gap: 'var(--s3)', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 140 }}><label>Type</label>
          <select value={type} onChange={e => setType(e.target.value)}>
            {state.group_types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 140 }}><label>Owns gate</label>
          <select value={gate} onChange={e => setGate(e.target.value)}>
            <option value="">— none —</option>
            {state.routable_gates.map(g => (
              <option key={g} value={g} disabled={takenGates.has(g)}>
                {g}{takenGates.has(g) ? ' (taken)' : ''}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field"><label>Distribution list <span className="hint">(optional — mails this instead of members)</span></label>
        <input value={dl} onChange={e => setDl(e.target.value)} placeholder="team-dl@certainti.ai" /></div>

      <div className="field">
        <label>Members <span className="hint">(who can approve; only active people are mailed)</span></label>
        {state.people.length === 0 ? <p className="hint">Add people first.</p> : (
          <div style={{ display: 'grid', gap: 4 }}>
            {state.people.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: p.active ? 1 : 0.55 }}>
                <input type="checkbox" checked={members.includes(p.id)} onChange={() => toggleMember(p.id)} />
                <span>{p.name}</span>
                <span className="hint mono">{p.email}</span>
                {!p.active && <span className="chip dashed">inactive</span>}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="field"><label>Approval mode</label>
        {isSecurity ? (
          <p className="hint">Security is always <b>active review</b> — never a standing delegation.</p>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--s3)' }}>
            {(['active-review', 'standing-delegation'] as const).map(m => (
              <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} /> {m}
              </label>
            ))}
          </div>
        )}
      </div>

      {members.length > 0 && (
        <div className="field">
          <label>Escalation timeouts <span className="hint">(hours before the next member is reminded; blank = not in the ladder)</span></label>
          <div style={{ display: 'grid', gap: 4 }}>
            {members.map(id => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{person(id)?.name}</span>
                <input type="number" min={1} style={{ width: 90 }}
                  value={esc.find(r => r.person_id === id)?.timeout_hours ?? ''}
                  onChange={e => setRung(id, e.target.value)} placeholder="hrs" />
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <p style={{ color: 'var(--critical)', fontSize: 'var(--t-sm)' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 'var(--s2)' }}>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
          {busy ? 'Saving…' : group ? 'Save changes' : 'Create group'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function GroupCard({ group, state, onEdit }: { group: Group; state: TeamState; onEdit: () => void }) {
  const memberNames = group.members
    .map(id => state.people.find(p => p.id === id))
    .filter(Boolean) as Person[];
  const starved = group.owns_gate ? state.starved_gates.includes(group.owns_gate) : false;
  return (
    <article className="panel" style={{ marginBottom: 'var(--s3)' }}>
      <header className="panel-head">
        <h2 style={{ fontSize: 'var(--t-h2)' }}>{group.name}</h2>
        <span className="chip">{group.type}</span>
        {group.owns_gate
          ? <span className={`chip ${starved ? 'critical' : 'healthy'}`}>owns {group.owns_gate}</span>
          : <span className="chip dashed">no gate</span>}
        <span className="grow" />
        <button className="btn" disabled={STATIC_DEMO} onClick={onEdit}>Edit</button>
      </header>
      <div className="panel-body">
        <dl className="tile-meta">
          <dt>mails</dt>
          <dd>{group.group_email
            ? <span className="mono">{group.group_email} <span className="hint">(DL)</span></span>
            : memberNames.length
              ? memberNames.map(p => <span key={p.id} className="chip" style={{ marginRight: 4, opacity: p.active ? 1 : 0.55 }}>{p.name}</span>)
              : <Absent>no members</Absent>}</dd>
          <dt>mode</dt><dd>{group.approval_mode}</dd>
          <dt>escalation</dt>
          <dd>{group.escalation_order.length
            ? group.escalation_order.map(r => `${state.people.find(p => p.id === r.person_id)?.name ?? '?'} ${r.timeout_hours}h`).join(' → ')
            : <Absent>none set</Absent>}</dd>
        </dl>
        {starved && <p style={{ color: 'var(--critical)', fontSize: 'var(--t-sm)' }}>
          This group owns {group.owns_gate} but has no active member to mail — reactivate someone or add a distribution list.</p>}
      </div>
    </article>
  );
}

export function Team() {
  const { data, error, loading, reload } = usePoll<TeamState>('/api/team', 20000);
  const [editing, setEditing] = useState<string | null>(null); // group id, or 'new'

  if (error) return <ErrorState what="the team configuration" error={error} />;
  if (loading || !data) return <Loading what="team" />;

  const uncovered = data.unassigned_gates;

  return (
    <>
      <DemoNote />

      {uncovered.length > 0 && (
        <div role="alert" style={{
          border: '1px solid var(--critical)', background: 'var(--critical-dim)',
          borderRadius: 'var(--radius-sm)', padding: 'var(--s3)', marginBottom: 'var(--s4)', fontSize: 'var(--t-sm)',
        }}>
          <b>{uncovered.length} gate{uncovered.length === 1 ? '' : 's'} unassigned</b> — an approval request for
          {' '}<span className="mono">{uncovered.join(', ')}</span> would reach no one. Give each an owning group below.
        </div>
      )}

      <Panel title="Gate coverage"><CoverageStrip state={data} /></Panel>

      <div style={{ display: 'grid', gap: 'var(--s4)', gridTemplateColumns: 'minmax(0, 320px) 1fr', marginTop: 'var(--s4)' }}>
        <div>
          <Panel title={`People · ${data.people.length}`}>
            {data.people.length === 0
              ? <EmptyState title="No people yet"><p>Add the reviewers and approvers who sign the gates.</p></EmptyState>
              : data.people.map(p => <PersonRow key={p.id} person={p} onChange={reload} />)}
            <div style={{ marginTop: 'var(--s3)' }}><AddPerson onDone={reload} /></div>
          </Panel>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--s3)' }}>
            <h2 style={{ fontSize: 'var(--t-h2)', margin: 0 }}>Groups · {data.groups.length}</h2>
            <span className="grow" style={{ flex: 1 }} />
            {editing !== 'new' && <button className="btn btn-primary" disabled={STATIC_DEMO}
              onClick={() => setEditing('new')}>+ New group</button>}
          </div>

          {editing === 'new' && (
            <GroupEditor group={null} state={data}
              onDone={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />
          )}

          {data.groups.length === 0 && editing !== 'new' && (
            <EmptyState title="No groups yet"><p>Create a group and give it a gate to start routing approvals.</p></EmptyState>
          )}

          {data.groups.map(g => editing === g.id
            ? <GroupEditor key={g.id} group={g} state={data}
                onDone={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />
            : <GroupCard key={g.id} group={g} state={data} onEdit={() => setEditing(g.id)} />)}
        </div>
      </div>
    </>
  );
}
