import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, FormEvent } from 'react';
import { ApiError, STATIC_DEMO, patchJson, postJson, usePoll } from './api';
import type {
  ApprovalMode, EscalationRung, GroupType, TeamGroup, TeamPayload, TeamPerson,
} from './types';
import { Absent, EmptyState, ErrorState, Loading, Panel } from './ui';

/**
 * Team & routing — who gets mailed for each gate, configured entirely here.
 * The Mailer reads only this config, so changing a recipient is a UI action,
 * never a code change. Companion surface to Approvals: Approvals shows the
 * decisions, this screen configures where those decision requests are routed.
 *
 * Everything below edits a DRAFT. Nothing persists until Save routing, which
 * validates, then writes people first (so new members exist before a group
 * claims them) and groups after. The client guard is UX; the server guard in
 * src/team.js is truth, and its refusals land on the offending card.
 */

/* ---------- the draft model ---------- */

interface DraftPerson {
  id: string; name: string; email: string;
  jira_account: string | null; github_handle: string | null; active: boolean;
}
interface DraftGroup {
  id: string; name: string; type: GroupType;
  owns_gate: string | null; group_email: string | null;
  member_ids: string[]; approval_mode: ApprovalMode;
  escalation_order: EscalationRung[];
}
interface Draft { people: DraftPerson[]; groups: DraftGroup[] }

const isTmp = (id: string) => id.startsWith('tmp_');
const tmpId = () => `tmp_${Math.random().toString(36).slice(2, 10)}`;
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const pickPerson = (p: TeamPerson): DraftPerson => ({
  id: p.id, name: p.name, email: p.email,
  jira_account: p.jira_account, github_handle: p.github_handle, active: p.active,
});
const pickGroup = (g: TeamGroup): DraftGroup => ({
  id: g.id, name: g.name, type: g.type,
  owns_gate: g.owns_gate, group_email: g.group_email,
  member_ids: [...g.member_ids], approval_mode: g.approval_mode,
  escalation_order: g.escalation_order.map(r => ({ ...r })),
});

const personBody = (p: DraftPerson) => ({
  name: p.name.trim(), email: p.email.trim(),
  jira_account: p.jira_account ?? '', github_handle: p.github_handle ?? '',
  active: p.active,
});
const groupBody = (g: DraftGroup, idMap: Record<string, string>) => ({
  name: g.name.trim(), type: g.type,
  owns_gate: g.owns_gate, group_email: g.group_email ?? '',
  member_ids: g.member_ids.map(id => idMap[id] ?? id),
  approval_mode: g.approval_mode,
  escalation_order: g.escalation_order.map(r => ({ ...r, person_id: idMap[r.person_id] ?? r.person_id })),
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Lets the shell warn before navigating away from unsaved routing. */
export const teamDirty = { current: false };

const MODE_LABEL: Record<ApprovalMode, string> = {
  active_review: 'active review',
  standing_delegation: 'standing delegation',
};
const TYPE_HELP: Record<GroupType, string> = {
  dev: 'developers', qa: 'testers', devops: 'devops', ba: 'business analysis', security: 'security',
};

const demoNote = STATIC_DEMO
  ? 'Read-only in the static demo — routing is written by the backend, which is not connected here.'
  : null;

/* ---------- validation: guards enforced before Save ---------- */

interface Guard { hard: Map<string, string>; blocks: string[]; uncovered: string[] }

function validate(draft: Draft, gateOrder: string[]): Guard {
  const hard = new Map<string, string>();
  const blocks: string[] = [];
  const put = (id: string, msg: string) => { if (!hard.has(id)) hard.set(id, msg); blocks.push(msg); };

  const emails = new Map<string, DraftPerson>();
  for (const p of draft.people) {
    const email = p.email.trim().toLowerCase();
    if (!p.name.trim()) put(p.id, 'a person needs a name');
    else if (!email) put(p.id, `${p.name.trim()} needs an email address`);
    else if (!isEmail(email)) put(p.id, `"${p.email.trim()}" is not a valid email address`);
    else if (emails.has(email)) put(p.id, `${email} is used twice — emails must be unique`);
    else emails.set(email, p);
  }

  for (const g of draft.groups) {
    const label = g.name.trim() || 'an unnamed group';
    if (!g.name.trim()) put(g.id, 'a group needs a name');
    if (g.group_email && g.group_email.trim() && !isEmail(g.group_email.trim())) {
      put(g.id, `${label}: "${g.group_email.trim()}" is not a valid DL address`);
    }
    if (g.owns_gate) {
      const active = g.member_ids
        .map(id => draft.people.find(p => p.id === id))
        .filter(p => p && p.active);
      if (active.length === 0) {
        put(g.id, `${label} owns ${g.owns_gate} but has no active members — add a member or release the gate`);
      }
    }
    for (const r of g.escalation_order) {
      if (!g.member_ids.includes(r.person_id)) put(g.id, `${label}: an escalation rung is not a member`);
      if (!Number.isFinite(r.timeout_hours) || r.timeout_hours <= 0) {
        put(g.id, `${label}: every escalation timeout must be a positive number of hours`);
      }
    }
  }

  // Soft, never blocks Save: partial setup is allowed, the gap just stays loud.
  const uncovered = gateOrder.filter(gate => !draft.groups.some(g => g.owns_gate === gate));
  return { hard, blocks: [...new Set(blocks)], uncovered };
}

/* ---------- gate-coverage strip: the guard, always visible ---------- */

function CoverageStrip({ gateOrder, draft }: { gateOrder: string[]; draft: Draft }) {
  return (
    <div className="covstrip" role="list" aria-label="gate coverage">
      {gateOrder.map(gate => {
        const owner = draft.groups.find(g => g.owns_gate === gate);
        return (
          <span key={gate} role="listitem"
            className={`covgate ${owner ? 'is-covered' : 'is-uncovered'}`}
            title={owner ? `${gate} → ${owner.name || 'unnamed group'}` : `${gate} is unassigned`}>
            {gate} <span aria-hidden="true">{owner ? '●' : '⚠'}</span>
            <span className="visually-hidden">{owner ? `owned by ${owner.name}` : 'unassigned'}</span>
          </span>
        );
      })}
    </div>
  );
}

/* ---------- people pane ---------- */

const BLANK_PERSON = { name: '', email: '', jira_account: '', github_handle: '', active: true };

function PersonForm({ initial, onSubmit, onCancel, submitLabel }: {
  initial: typeof BLANK_PERSON; submitLabel: string;
  onSubmit: (p: typeof BLANK_PERSON) => void; onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(f); };
  return (
    <form onSubmit={submit} className="person-form">
      <div className="row-2">
        <div className="field">
          <label>Name</label>
          <input value={f.name} required onChange={e => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Email</label>
          <input type="email" value={f.email} required onChange={e => setF({ ...f, email: e.target.value })} />
        </div>
      </div>
      <div className="row-2">
        <div className="field">
          <label>Jira account <span className="hint">(optional)</span></label>
          <input value={f.jira_account} onChange={e => setF({ ...f, jira_account: e.target.value })} />
        </div>
        <div className="field">
          <label>GitHub handle <span className="hint">(optional)</span></label>
          <input value={f.github_handle} onChange={e => setF({ ...f, github_handle: e.target.value })} />
        </div>
      </div>
      <label style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center' }}>
        <input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={f.active}
          onChange={e => setF({ ...f, active: e.target.checked })} />
        <span>Active — mailed, and counts as an approver</span>
      </label>
      <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
        <button className="btn btn-primary" type="submit"
          disabled={!f.name.trim() || !f.email.trim()}>{submitLabel}</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function PeoplePane({ draft, update, guard, errors }: {
  draft: Draft; update: (fn: (d: Draft) => Draft) => void;
  guard: Guard; errors: Record<string, string>;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const typeHint = (p: DraftPerson) => {
    const types = [...new Set(draft.groups.filter(g => g.member_ids.includes(p.id)).map(g => g.type))];
    return types.length ? types.join(', ') : null;
  };

  const addPerson = (f: typeof BLANK_PERSON) => {
    update(d => ({ ...d, people: [...d.people, {
      id: tmpId(), name: f.name, email: f.email,
      jira_account: f.jira_account.trim() || null, github_handle: f.github_handle.trim() || null,
      active: f.active,
    }] }));
    setAdding(false);
  };

  const editPerson = (id: string, f: typeof BLANK_PERSON) => {
    update(d => ({ ...d, people: d.people.map(p => p.id === id ? {
      ...p, name: f.name, email: f.email,
      jira_account: f.jira_account.trim() || null, github_handle: f.github_handle.trim() || null,
      active: f.active,
    } : p) }));
    setEditing(null);
  };

  const toggleActive = (p: DraftPerson) =>
    update(d => ({ ...d, people: d.people.map(x => x.id === p.id ? { ...x, active: !x.active } : x) }));

  const onDragStart = (e: DragEvent, p: DraftPerson) => {
    e.dataTransfer.setData('text/x-person-id', p.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <Panel title="People"
      aside={<button className="btn" disabled={STATIC_DEMO}
        onClick={() => { setAdding(a => !a); setEditing(null); }}>+ Add person</button>}>
      {adding && <PersonForm initial={BLANK_PERSON} submitLabel="Add to roster"
        onSubmit={addPerson} onCancel={() => setAdding(false)} />}

      {draft.people.length === 0 && !adding ? (
        <EmptyState title="Add your first person to start routing approvals">
          <p>Approval requests are mailed to the group that owns each gate, and groups are made of
            people. Nobody is here yet, so every gate routes nowhere.</p>
        </EmptyState>
      ) : (
        <>
          {draft.people.map(p => (
            <div key={p.id} id={`ent-${p.id}`}>
              {editing === p.id ? (
                <PersonForm submitLabel="Save person" onCancel={() => setEditing(null)}
                  initial={{ name: p.name, email: p.email, jira_account: p.jira_account ?? '',
                    github_handle: p.github_handle ?? '', active: p.active }}
                  onSubmit={f => editPerson(p.id, f)} />
              ) : (
                <div className={`roster-row ${p.active ? '' : 'is-inactive'}`}
                  draggable={!STATIC_DEMO} onDragStart={e => onDragStart(e, p)}
                  title="Drag onto a group to add as a member">
                  <span className="drag-grip" aria-hidden="true">⋮⋮</span>
                  <span className="roster-id">
                    <strong>{p.name || <Absent>unnamed</Absent>}</strong>
                    <span className="hint mono"> {p.email}</span>
                    {typeHint(p) && <span className="hint"> · {typeHint(p)}</span>}
                    {isTmp(p.id) && <span className="chip dashed" style={{ marginLeft: 'var(--s2)' }}>unsaved</span>}
                  </span>
                  <span className="grow" />
                  <button className={`chip ${p.active ? 'healthy' : 'dashed'} chip-btn`}
                    disabled={STATIC_DEMO} onClick={() => toggleActive(p)}
                    title={p.active
                      ? 'Active — click to deactivate. Soft: kept in history, removed from mailing and approver counts.'
                      : 'Inactive — never mailed, never counts as an approver. Click to reactivate.'}>
                    {p.active ? '● active' : '○ inactive'}
                  </button>
                  <button className="btn btn-slim" disabled={STATIC_DEMO}
                    onClick={() => { setEditing(p.id); setAdding(false); }}>Edit</button>
                </div>
              )}
              {(guard.hard.get(p.id) || errors[p.id]) && (
                <p className="card-error">{errors[p.id] ?? guard.hard.get(p.id)}</p>
              )}
            </div>
          ))}
          <p className="hint">Drag a person onto a group card to add them as a member. Inactive people
            stay listed for history but are never mailed and never count as approvers.</p>
        </>
      )}
    </Panel>
  );
}

/* ---------- groups pane ---------- */

function GroupCard({ group, draft, gateOrder, update, guard, error }: {
  group: DraftGroup; draft: Draft; gateOrder: string[];
  update: (fn: (d: Draft) => Draft) => void;
  guard: Guard; error: string | undefined;
}) {
  const [over, setOver] = useState(false);
  const [dragRung, setDragRung] = useState<number | null>(null);
  const patch = (changes: Partial<DraftGroup>) =>
    update(d => ({ ...d, groups: d.groups.map(g => g.id === group.id ? { ...g, ...changes } : g) }));

  const person = (id: string) => draft.people.find(p => p.id === id);
  const members = group.member_ids.map(person).filter(Boolean) as DraftPerson[];
  const activeMembers = members.filter(m => m.active);
  const security = group.type === 'security';

  /** One gate, one owner: taking a gate someone else owns asks first, then moves it. */
  const assignGate = (gate: string) => {
    if (!gate) { patch({ owns_gate: null }); return; }
    const owner = draft.groups.find(g => g.id !== group.id && g.owns_gate === gate);
    if (owner && !window.confirm(`${gate} is owned by ${owner.name || 'an unnamed group'} — move it here?`)) return;
    update(d => ({ ...d, groups: d.groups.map(g =>
      g.id === group.id ? { ...g, owns_gate: gate }
      : g.owns_gate === gate ? { ...g, owns_gate: null } : g) }));
  };

  const addMember = (id: string) => {
    if (!id || group.member_ids.includes(id)) return;
    patch({ member_ids: [...group.member_ids, id] });
  };
  /** Removing a member also drops their escalation rung — the list may only
   *  contain members of the group. */
  const removeMember = (id: string) => patch({
    member_ids: group.member_ids.filter(m => m !== id),
    escalation_order: group.escalation_order.filter(r => r.person_id !== id),
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    if (STATIC_DEMO) return;
    addMember(e.dataTransfer.getData('text/x-person-id'));
  };

  const setRungs = (escalation_order: EscalationRung[]) => patch({ escalation_order });
  const moveRung = (from: number, to: number) => {
    if (to < 0 || to >= group.escalation_order.length) return;
    const rungs = [...group.escalation_order];
    const [r] = rungs.splice(from, 1);
    rungs.splice(to, 0, r);
    setRungs(rungs);
  };

  const notMembers = draft.people.filter(p => !group.member_ids.includes(p.id));
  const notInEscalation = members.filter(m => !group.escalation_order.some(r => r.person_id === m.id));

  return (
    <section className={`group-card ${over ? 'is-over' : ''}`} id={`ent-${group.id}`}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)} onDrop={onDrop}
      aria-label={`group ${group.name}`}>
      <header className="group-head">
        <input className="group-name" value={group.name} disabled={STATIC_DEMO}
          onChange={e => patch({ name: e.target.value })} aria-label="group name" />
        <span className="chip">{group.type}</span>
        {isTmp(group.id) && <span className="chip dashed">unsaved</span>}
        <span className="grow" />
        {group.owns_gate
          ? <span className="chip healthy">owns {group.owns_gate}</span>
          : <span className="chip dashed">owns no gate</span>}
      </header>

      <div className="row-2">
        <div className="field">
          <label>Owns gate</label>
          <select value={group.owns_gate ?? ''} disabled={STATIC_DEMO}
            onChange={e => assignGate(e.target.value)}>
            <option value="">— none —</option>
            {gateOrder.map(g => {
              const owner = draft.groups.find(x => x.owns_gate === g);
              return <option key={g} value={g}>
                {g}{owner && owner.id !== group.id ? ` (owned by ${owner.name})` : ''}
              </option>;
            })}
          </select>
          <p className="hint">A gate has exactly one owning group; picking an owned one moves it here.</p>
        </div>
        <div className="field">
          <label>Group DL <span className="hint">(optional)</span></label>
          <input type="email" value={group.group_email ?? ''} disabled={STATIC_DEMO}
            placeholder="dev-review@example.com"
            onChange={e => patch({ group_email: e.target.value.trim() || null })} />
          <p className="hint">{group.group_email
            ? 'Mail goes to this DL — it wins over per-member mailing.'
            : 'Empty, so mail goes to each active member.'}</p>
        </div>
      </div>

      <div className="field">
        <label>Members</label>
        <div className={`dropzone ${over ? 'is-over' : ''}`}>
          {members.length === 0
            ? <span className="absent">no members — drag someone in from the roster</span>
            : members.map(m => (
              <span key={m.id} className={`chip member-chip ${m.active ? '' : 'dashed'}`}>
                {m.name}{!m.active && ' (inactive)'}
                <button className="chip-x" aria-label={`remove ${m.name}`} disabled={STATIC_DEMO}
                  onClick={() => removeMember(m.id)}>✕</button>
              </span>
            ))}
        </div>
        {notMembers.length > 0 && (
          <select value="" disabled={STATIC_DEMO} onChange={e => addMember(e.target.value)}
            aria-label={`add a member to ${group.name}`} style={{ marginTop: 'var(--s2)' }}>
            <option value="">+ add member…</option>
            {notMembers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
          </select>
        )}
        {group.owns_gate && activeMembers.length === 0 && (
          <p className="card-error">Owns {group.owns_gate} with no active member — approval requests
            would reach nobody. Save is blocked until this is fixed.</p>
        )}
      </div>

      <div className="field">
        <label>Approval mode</label>
        <div className="mode-toggle" role="group" aria-label="approval mode">
          {(['active_review', 'standing_delegation'] as ApprovalMode[]).map(m => (
            <button key={m} className={`btn btn-slim ${group.approval_mode === m ? 'is-on' : ''}`}
              disabled={STATIC_DEMO || (security && m !== 'active_review')}
              title={security && m !== 'active_review'
                ? 'Security review is a judgement, not a rubber stamp — always active review.' : undefined}
              onClick={() => patch({ approval_mode: m })}>
              {group.approval_mode === m ? '● ' : '○ '}{MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {security && <p className="hint">Locked for security groups — always active review.</p>}
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label>Escalation order</label>
        {group.escalation_order.length === 0
          ? <p className="hint" style={{ marginTop: 0 }}>No rungs — reminders never escalate for this group.</p>
          : group.escalation_order.map((r, i) => {
            const m = person(r.person_id);
            return (
              <div key={r.person_id} className={`esc-row ${dragRung === i ? 'is-dragging' : ''}`}
                draggable={!STATIC_DEMO}
                onDragStart={e => { setDragRung(i); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragRung(null)}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); if (dragRung !== null && dragRung !== i) moveRung(dragRung, i); setDragRung(null); }}>
                <span className="drag-grip" aria-hidden="true">⋮⋮</span>
                <span className="mono esc-n">{i + 1}.</span>
                <span className="esc-name">{m ? m.name : r.person_id}{m && !m.active && <span className="hint"> (inactive)</span>}</span>
                <input className="esc-timeout" type="number" min={1} value={r.timeout_hours || ''}
                  disabled={STATIC_DEMO} aria-label={`timeout in hours for ${m?.name ?? 'rung'}`}
                  onChange={e => setRungs(group.escalation_order.map((x, j) =>
                    j === i ? { ...x, timeout_hours: Number(e.target.value) } : x))} />
                <span className="hint">h</span>
                <button className="btn btn-slim" disabled={STATIC_DEMO || i === 0}
                  onClick={() => moveRung(i, i - 1)} aria-label="move up">↑</button>
                <button className="btn btn-slim" disabled={STATIC_DEMO || i === group.escalation_order.length - 1}
                  onClick={() => moveRung(i, i + 1)} aria-label="move down">↓</button>
                <button className="btn btn-slim" disabled={STATIC_DEMO}
                  onClick={() => setRungs(group.escalation_order.filter((_, j) => j !== i))}
                  aria-label={`remove ${m?.name ?? 'rung'} from escalation`}>✕</button>
              </div>
            );
          })}
        {notInEscalation.length > 0 && (
          <select value="" disabled={STATIC_DEMO} style={{ marginTop: 'var(--s2)' }}
            aria-label={`add an escalation rung to ${group.name}`}
            onChange={e => e.target.value && setRungs([...group.escalation_order,
              { person_id: e.target.value, timeout_hours: 24 }])}>
            <option value="">+ add rung…</option>
            {notInEscalation.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <p className="hint">When a rung stays silent past its timeout, the reminder escalates to the
          next. Drag to reorder; only members of this group can be rungs.</p>
      </div>

      {(guard.hard.get(group.id) || error) && <p className="card-error">{error ?? guard.hard.get(group.id)}</p>}
    </section>
  );
}

function GroupsPane({ draft, gateOrder, groupTypes, update, guard, errors }: {
  draft: Draft; gateOrder: string[]; groupTypes: GroupType[];
  update: (fn: (d: Draft) => Draft) => void;
  guard: Guard; errors: Record<string, string>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<GroupType>('dev');

  const create = (e: FormEvent) => {
    e.preventDefault();
    update(d => ({ ...d, groups: [...d.groups, {
      id: tmpId(), name: name.trim(), type,
      owns_gate: null, group_email: null, member_ids: [],
      approval_mode: 'active_review', escalation_order: [],
    }] }));
    setAdding(false); setName(''); setType('dev');
  };

  return (
    <Panel title="Groups"
      aside={<button className="btn" disabled={STATIC_DEMO} onClick={() => setAdding(a => !a)}>+ New group</button>}>
      {adding && (
        <form onSubmit={create} className="person-form">
          <div className="row-2">
            <div className="field">
              <label>Name</label>
              <input value={name} required onChange={e => setName(e.target.value)} placeholder="Developers" />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={type} onChange={e => setType(e.target.value as GroupType)}>
                {groupTypes.map(t => <option key={t} value={t}>{t} — {TYPE_HELP[t]}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--s2)' }}>
            <button className="btn btn-primary" type="submit" disabled={!name.trim()}>Create group</button>
            <button className="btn" type="button" onClick={() => setAdding(false)}>Cancel</button>
          </div>
          <p className="hint">Name and type now; assign its gate on the card once it exists.</p>
        </form>
      )}

      {draft.groups.length === 0 && !adding ? (
        <EmptyState title="No groups yet">
          <p>A group owns a gate, and its DL or active members are who an approval request for that
            gate is mailed to. Until one owns a gate, the coverage strip stays red.</p>
        </EmptyState>
      ) : (
        draft.groups.map(g => (
          <GroupCard key={g.id} group={g} draft={draft} gateOrder={gateOrder}
            update={update} guard={guard} error={errors[g.id]} />
        ))
      )}
    </Panel>
  );
}

/* ---------- the surface ---------- */

export function Team() {
  const { data, error, loading, reload } = usePoll<TeamPayload>('/api/team', 30000);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [entityErrors, setEntityErrors] = useState<Record<string, string>>({});
  const dirtyRef = useRef(false);

  const dirty = draft !== null && baseline !== null && !same(draft, baseline);
  dirtyRef.current = dirty;

  // Server refreshes must never clobber an operator's unsaved edits — the draft
  // resyncs from the server only while it is clean (or gone after a save).
  useEffect(() => {
    if (!data) return;
    if (draft !== null && dirtyRef.current) return;
    const base = { people: data.people.map(pickPerson), groups: data.groups.map(pickGroup) };
    setDraft(base); setBaseline(base);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    teamDirty.current = dirty;
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); teamDirty.current = false; };
  }, [dirty]);

  const guard = useMemo(
    () => draft && data ? validate(draft, data.gate_order) : null,
    [draft, data]);

  if (error && !data) return <ErrorState what="team & routing" error={error} />;
  if (loading || !data || !draft || !baseline || !guard) return <Loading what="team & routing" />;

  const update = (fn: (d: Draft) => Draft) => { setDraft(d => d && fn(d)); setSaveError(null); };

  /**
   * Save routing: people first (new members must exist before a group claims
   * them), then groups, each written with its full draft state so gate moves
   * resolve the same whatever the order. On a refusal the loop stops, the
   * message lands on the offending card, and everything already written stays
   * written — re-saving is safe because tmp ids are swapped for real ones as
   * each POST succeeds.
   */
  async function save() {
    if (!draft || !baseline || !guard) return;
    setSaving(true); setSaveError(null); setEntityErrors({});
    const work: Draft = JSON.parse(JSON.stringify(draft));
    const idMap: Record<string, string> = {};
    let failed: string | null = null;

    try {
      for (const p of work.people) {
        const base = baseline.people.find(b => b.id === p.id);
        try {
          if (isTmp(p.id)) {
            const res = await postJson<{ person: TeamPerson }>('/api/team/person', personBody(p));
            idMap[p.id] = res.person.id;
            p.id = res.person.id;
          } else if (!base || !same(personBody(p), personBody(base))) {
            await patchJson(`/api/team/person/${p.id}`, personBody(p));
          }
        } catch (err) { failed = p.id; throw err; }
      }
      for (const g of work.groups) {
        g.member_ids = g.member_ids.map(id => idMap[id] ?? id);
        g.escalation_order = g.escalation_order.map(r => ({ ...r, person_id: idMap[r.person_id] ?? r.person_id }));
        const base = baseline.groups.find(b => b.id === g.id);
        try {
          if (isTmp(g.id)) {
            const res = await postJson<{ group: TeamGroup }>('/api/team/group', groupBody(g, idMap));
            g.id = res.group.id;
          } else if (!base || !same(groupBody(g, {}), groupBody(base, {}))) {
            await patchJson(`/api/team/group/${g.id}`, groupBody(g, idMap));
          }
        } catch (err) { failed = g.id; throw err; }
      }
      // Everything written: drop the draft and resync from the server's truth.
      setDraft(null); setBaseline(null);
      reload();
    } catch (err) {
      const msg = (err as ApiError).message;
      setSaveError(msg);
      if (failed) {
        setEntityErrors({ [failed]: msg });
        // Keep the draft (with any real ids already earned) and show the card that failed.
        setDraft(work);
        document.getElementById(`ent-${failed}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } finally {
      setSaving(false);
    }
  }

  const discard = () => { setDraft(baseline); setSaveError(null); setEntityErrors({}); };
  const blocked = guard.blocks.length > 0;

  return (
    <>
      <CoverageStrip gateOrder={data.gate_order} draft={draft} />

      {guard.uncovered.length > 0 && (
        <div className="banner" role="alert">
          <strong>{guard.uncovered.join(', ')} {guard.uncovered.length === 1 ? 'is' : 'are'} unassigned</strong>
          {' '}— approval requests for {guard.uncovered.length === 1 ? 'it' : 'them'} will not reach anyone.
          Assign {guard.uncovered.length === 1 ? 'it' : 'each'} to a group below. Other edits still save.
        </div>
      )}

      {demoNote && <p className="hint" style={{ marginBottom: 'var(--s4)' }}>{demoNote}</p>}

      <div className="team-grid">
        <PeoplePane draft={draft} update={update} guard={guard} errors={entityErrors} />
        <GroupsPane draft={draft} gateOrder={data.gate_order} groupTypes={data.group_types}
          update={update} guard={guard} errors={entityErrors} />
      </div>

      {dirty && (
        <div className="savebar" role="status">
          <span><strong>Unsaved changes</strong> — nothing persists until saved.</span>
          {blocked && (
            <span className="savebar-blocks">
              {guard.blocks.map(b => <span key={b} className="card-error" style={{ margin: 0 }}>{b}</span>)}
            </span>
          )}
          {saveError && !blocked && <span className="card-error" style={{ margin: 0 }}>{saveError}</span>}
          <span className="grow" />
          <button className="btn" onClick={discard} disabled={saving}>Discard</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || blocked || STATIC_DEMO}
            title={blocked ? 'Resolve the errors above first' : undefined}>
            {saving ? 'Saving…' : 'Save routing'}
          </button>
        </div>
      )}

      <p className="hint" style={{ marginTop: 'var(--s5)' }}>
        Stored server-side at <code className="mono">{data.team_path}</code>. The Mailer resolves
        recipients from this config alone: gate → owning group → its DL, or each active member.
      </p>
    </>
  );
}
