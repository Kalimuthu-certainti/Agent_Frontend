import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, STATIC_DEMO, deleteJson, postJson, putJson, usePoll } from './api';
import type {
  ConfigGroup, MailConfig, MailTestResult, NotifyEvent, RegistryUser, Role, SettingsPayload,
} from './types';
import { Absent, EmptyState, ErrorState, Loading, Panel, when } from './ui';

/**
 * Configuration — mail, configuration groups, and the user registry.
 *
 * Three things that only make sense together: mail is *how* a notification is
 * sent, a group decides *what* is worth sending, and the registry is *who*
 * receives it. Splitting them across three screens would hide that chain, so
 * they are three sections of one surface, in that order.
 *
 * Honesty rules carried from the rest of the panel:
 *  - The SMTP password is never sent to the browser, so this screen shows
 *    whether one is stored, never the value, and an untouched field leaves it be.
 *  - Nothing claims mail works until a test has actually been through the
 *    server. "Saved" and "delivers" are different statements and are worded so.
 */

type Section = 'mail' | 'groups' | 'users';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'mail', label: 'Mail' },
  { id: 'groups', label: 'Configuration groups' },
  { id: 'users', label: 'Users' },
];

const SECURITY_LABEL: Record<string, string> = {
  tls: 'TLS (implicit, usually port 465)',
  starttls: 'STARTTLS (upgrade, usually port 587)',
  none: 'No encryption (local relay only)',
};

const EVENT_LABEL: Record<string, string> = {
  'approval.recorded': 'Approval recorded — someone approved or bounced a gate',
  'requirement.created': 'Requirement created — a new ticket was written into Jira',
};

/** What a role lets someone do here. Shown beside every member, because a role
 *  name alone does not tell you what that person is actually performing. */
const ROLE_PERMITS: Record<string, string> = {
  owner: 'owns the configuration — mail, groups and the registry',
  approver: 'decides on gates — approves or bounces, and is mailed when a decision is recorded',
  viewer: 'reads the panel — sees every screen, changes nothing',
};

/** Every write on this screen shares the same busy / error / confirmation shape. */
function useWrite(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run<T>(action: () => Promise<T>, success?: (result: T) => string): Promise<T | null> {
    setBusy(true); setError(null); setNote(null);
    try {
      const result = await action();
      reload();
      if (success) setNote(success(result));
      return result;
    } catch (err) {
      setError((err as ApiError).message);
      return null;
    } finally { setBusy(false); }
  }
  return { busy, error, note, run, clear: () => { setError(null); setNote(null); } };
}

function Feedback({ error, note }: { error: string | null; note: string | null }) {
  if (error) return <p style={{ color: 'var(--critical)', fontSize: 'var(--t-sm)', margin: 'var(--s2) 0' }}>{error}</p>;
  if (note) return <p style={{ color: 'var(--healthy)', fontSize: 'var(--t-sm)', margin: 'var(--s2) 0' }}>{note}</p>;
  return null;
}

const demoNote = STATIC_DEMO
  ? 'Disabled in the static demo — configuration is written by the backend, which is not connected here.'
  : null;

/* ------------------------------------------------------------------ mail -- */

function MailSection({ data, reload }: { data: SettingsPayload; reload: () => void }) {
  const mail = data.mail;
  const [host, setHost] = useState(mail?.host ?? '');
  const [port, setPort] = useState(String(mail?.port ?? 587));
  const [security, setSecurity] = useState(mail?.security ?? 'starttls');
  const [username, setUsername] = useState(mail?.username ?? '');
  // undefined means "leave whatever is stored alone" — see the note by the field.
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [fromName, setFromName] = useState(mail?.from_name ?? '');
  const [fromEmail, setFromEmail] = useState(mail?.from_email ?? '');
  const [replyTo, setReplyTo] = useState(mail?.reply_to ?? '');
  const [testTo, setTestTo] = useState('');
  const [test, setTest] = useState<MailTestResult | null>(null);

  const save = useWrite(reload);
  const probe = useWrite(reload);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTest(null);
    await save.run<{ mail: MailConfig }>(
      () => putJson('/api/settings/mail', {
        host: host.trim(), port: Number(port), security,
        username: username.trim(),
        ...(password === undefined ? {} : { password }),
        from_name: fromName.trim(), from_email: fromEmail.trim(), reply_to: replyTo.trim(),
      }),
      () => 'Settings saved. Saved is not the same as delivering — send a test to prove the route.',
    );
    setPassword(undefined);
  }

  async function sendTest(e: FormEvent) {
    e.preventDefault();
    setTest(null);
    const result = await probe.run<MailTestResult>(
      () => postJson('/api/settings/mail/test', { to: testTo.trim() }),
      r => `Accepted by the server for ${r.to.join(', ')} in ${r.ms}ms.`);
    if (result) setTest(result);
  }

  return (
    <>
      <Panel title="SMTP server"
        aside={mail
          ? <span className={`chip ${data.mail_configured ? 'healthy' : 'warning'}`}>
            {data.mail_configured ? 'configured' : 'incomplete'}
          </span>
          : <span className="chip dashed">not configured</span>}>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="host">Host</label>
            <input id="host" value={host} required onChange={e => setHost(e.target.value)}
              placeholder="smtp.example.com" />
          </div>

          <div className="row-2">
            <div className="field">
              <label htmlFor="port">Port</label>
              <input id="port" value={port} inputMode="numeric" required
                onChange={e => setPort(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="security">Encryption</label>
              <select id="security" value={security} onChange={e => setSecurity(e.target.value as never)}>
                {data.security_options.map(s => (
                  <option key={s} value={s}>{SECURITY_LABEL[s] ?? s}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="row-2">
            <div className="field">
              <label htmlFor="username">Username</label>
              <input id="username" value={username} onChange={e => setUsername(e.target.value)}
                placeholder="leave empty for an unauthenticated relay" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="new-password"
                value={password ?? ''}
                placeholder={mail?.password_set ? '•••••••• stored' : 'not set'}
                onChange={e => setPassword(e.target.value)} />
              <p className="hint">
                {mail?.password_set
                  ? 'A password is stored on the server. It is never sent to this screen; leave this ' +
                    'field alone to keep it, or type a new one to replace it.'
                  : 'Stored on the server only, never returned to the browser.'}
              </p>
            </div>
          </div>

          <div className="row-2">
            <div className="field">
              <label htmlFor="from-name">From name</label>
              <input id="from-name" value={fromName} onChange={e => setFromName(e.target.value)}
                placeholder="Agent Control" />
            </div>
            <div className="field">
              <label htmlFor="from-email">From address</label>
              <input id="from-email" value={fromEmail} required type="email"
                onChange={e => setFromEmail(e.target.value)} placeholder="agent-control@example.com" />
            </div>
          </div>

          <div className="field">
            <label htmlFor="reply-to">Reply-to</label>
            <input id="reply-to" value={replyTo} type="email" onChange={e => setReplyTo(e.target.value)}
              placeholder="optional — where replies should land" />
          </div>

          <Feedback error={save.error} note={save.note} />
          <button className="btn btn-primary" type="submit" disabled={save.busy || STATIC_DEMO}>
            {save.busy ? 'Saving…' : 'Save mail settings'}
          </button>
          {demoNote && <p className="hint">{demoNote}</p>}
          {mail && <p className="hint">Last changed {when(mail.updated_at)}.</p>}
        </form>
      </Panel>

      <Panel title="Send a test message">
        {!data.mail_configured ? (
          <EmptyState title="Nothing to test yet">
            <p>Save a host, port and from-address above first. A test needs a complete server —
              a username without a password would only fail at authentication.</p>
          </EmptyState>
        ) : (
          <form onSubmit={sendTest}>
            <div className="field">
              <label htmlFor="test-to">Send to</label>
              <input id="test-to" type="email" value={testTo} required
                onChange={e => setTestTo(e.target.value)} placeholder="you@example.com" />
              <p className="hint">Uses the settings exactly as saved, including the stored password.</p>
            </div>
            <Feedback error={probe.error} note={probe.note} />
            <button className="btn" type="submit" disabled={probe.busy || STATIC_DEMO || !testTo.trim()}>
              {probe.busy ? 'Sending…' : 'Send test'}
            </button>
            {demoNote && <p className="hint">{demoNote}</p>}
            {test && (
              <details style={{ marginTop: 'var(--s3)' }}>
                <summary className="hint">SMTP transcript — what the server actually said</summary>
                <pre className="mono" style={{ fontSize: 'var(--t-sm)', overflowX: 'auto' }}>
                  {test.transcript.join('\n')}
                </pre>
              </details>
            )}
          </form>
        )}
      </Panel>
    </>
  );
}

/* ---------------------------------------------------------------- groups -- */

const BLANK_GROUP = {
  name: '', team: '', description: '', roles: [] as Role[], notify_events: [] as NotifyEvent[],
};

/** Everyone holding a role the group claims. The rule, in one line. */
const membersOf = (group: ConfigGroup, users: RegistryUser[]) =>
  users.filter(u => group.roles.includes(u.role));

const groupsOf = (user: RegistryUser, groups: ConfigGroup[]) =>
  groups.filter(g => g.roles.includes(user.role));

/** The members of one group: who they are and what their role lets them do. */
function GroupDetail({ group, users, onBack }: {
  group: ConfigGroup; users: RegistryUser[]; onBack: () => void;
}) {
  const members = membersOf(group, users);

  return (
    <Panel title={group.name}
      aside={<button className="btn" onClick={onBack}>← All groups</button>}>
      {/* .tile-meta is designed to close a tile, so its top rule and spacing are
          dropped here where it opens a panel instead. */}
      <dl className="tile-meta"
        style={{ marginTop: 0, paddingTop: 0, borderTop: 0, marginBottom: 'var(--s4)' }}>
        <dt>Team</dt><dd>{group.team}</dd>
        <dt>Claims roles</dt>
        <dd>{group.roles.length === 0
          ? <Absent>none — so this group has no members</Absent>
          : group.roles.map(r => <span key={r} className="chip" style={{ marginRight: 'var(--s1)' }}>{r}</span>)}
        </dd>
        <dt>Notifies on</dt>
        <dd>{group.notify_events.length === 0
          ? <Absent>nothing</Absent>
          : group.notify_events.map(ev => (
            <span key={ev} className="chip" style={{ marginRight: 'var(--s1)' }}>
              <code className="mono">{ev}</code>
            </span>))}
        </dd>
      </dl>
      {group.description && <p className="lede" style={{ marginTop: 0 }}>{group.description}</p>}

      {members.length === 0 ? (
        <EmptyState title="No members">
          <p>{group.roles.length === 0
            ? 'This group claims no role, so nobody can be in it. Edit it and claim one.'
            : `Nobody in the registry holds ${group.roles.join(' or ')}. Add someone with that ` +
              'role and they join this group immediately — membership follows the role.'}</p>
        </EmptyState>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr><th>Member</th><th>Email</th><th>Role</th><th>What that role does</th><th>Mail</th></tr>
            </thead>
            <tbody>
              {members.map(u => (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong></td>
                  <td className="mono">{u.email}</td>
                  <td>{u.role}</td>
                  <td>{ROLE_PERMITS[u.role]}</td>
                  <td>{u.notify
                    ? <span className="chip healthy">receives</span>
                    : <span className="chip dashed">muted</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint" style={{ marginTop: 'var(--s3)' }}>
        {members.length === 1 ? '1 member' : `${members.length} members`}, derived from the roles this
        group claims. Nobody is filed in by hand, so this list cannot drift from the registry.
      </p>
    </Panel>
  );
}

function GroupSection({ data, reload }: { data: SettingsPayload; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(BLANK_GROUP);
  const write = useWrite(reload);

  const opened = data.groups.find(g => g.id === open) ?? null;
  if (opened) {
    return <GroupDetail group={opened} users={data.users} onBack={() => setOpen(null)} />;
  }

  function edit(g: ConfigGroup) {
    setEditing(g.id);
    setDraft({
      name: g.name, team: g.team, description: g.description ?? '',
      roles: [...g.roles], notify_events: [...g.notify_events],
    });
    write.clear();
  }

  function cancel() { setEditing(null); setDraft(BLANK_GROUP); write.clear(); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: draft.name.trim(), team: draft.team.trim(), description: draft.description.trim(),
      roles: draft.roles, notify_events: draft.notify_events,
    };
    const done = editing
      ? await write.run(() => putJson(`/api/settings/groups/${editing}`, body), () => `Updated ${body.name}.`)
      : await write.run(() => postJson('/api/settings/groups', body), () => `Created ${body.name}.`);
    if (done) cancel();
  }

  async function remove(g: ConfigGroup) {
    const n = membersOf(g, data.users).length;
    await write.run(() => deleteJson(`/api/settings/groups/${g.id}`),
      () => `Deleted ${g.name}. Its ${n} member${n === 1 ? '' : 's'} stay in the registry — only the ` +
        'subscription is gone.');
  }

  const toggle = <T,>(list: T[], v: T) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];

  return (
    <>
      <Panel title="Groups" aside={<span className="hint">{data.groups.length} configured</span>}>
        {data.groups.length === 0 ? (
          <EmptyState title="No configuration groups yet">
            <p>A group ties a team to the events worth emailing them about, and claims the roles whose
              holders belong to it. Until one exists, nothing is notified — the panel still records
              every decision either way.</p>
          </EmptyState>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Group</th><th>Team</th><th>Claims roles</th><th>Notifies on</th>
                  <th className="num">Members</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map(g => {
                  const n = membersOf(g, data.users).length;
                  return (
                    <tr key={g.id}>
                      <td>
                        <button className="linkish" onClick={() => setOpen(g.id)}
                          aria-label={`Open ${g.name} and see its members`}>
                          <strong>{g.name}</strong>
                        </button>
                        {g.description && <div className="hint">{g.description}</div>}
                      </td>
                      <td>{g.team}</td>
                      <td>
                        {g.roles.length === 0
                          ? <Absent>none</Absent>
                          : g.roles.map(r => (
                            <span key={r} className="chip" style={{ marginRight: 'var(--s1)' }}>{r}</span>))}
                      </td>
                      <td>
                        {g.notify_events.length === 0
                          ? <Absent>nothing</Absent>
                          : g.notify_events.map(ev => (
                            <span key={ev} className="chip" style={{ marginRight: 'var(--s1)' }}>
                              <code className="mono">{ev}</code>
                            </span>))}
                      </td>
                      <td className="num mono">
                        <button className="linkish" onClick={() => setOpen(g.id)}>{n}</button>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn" onClick={() => setOpen(g.id)}>Members</button>{' '}
                        <button className="btn" onClick={() => edit(g)} disabled={STATIC_DEMO}>Edit</button>{' '}
                        <button className="btn btn-danger" onClick={() => remove(g)}
                          disabled={write.busy || STATIC_DEMO}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={editing ? 'Edit group' : 'New group'}>
        <form onSubmit={submit}>
          <div className="row-2">
            <div className="field">
              <label htmlFor="g-name">Name</label>
              <input id="g-name" value={draft.name} required
                onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Platform approvers" />
            </div>
            <div className="field">
              <label htmlFor="g-team">Team</label>
              <input id="g-team" value={draft.team} required
                onChange={e => setDraft({ ...draft, team: e.target.value })} placeholder="Platform" />
            </div>
          </div>

          <div className="field">
            <label htmlFor="g-desc">Description</label>
            <input id="g-desc" value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
              placeholder="optional — what this group is for" />
          </div>

          <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 var(--s4)' }}>
            <legend style={{ padding: 0 }}>Members: everyone holding these roles</legend>
            {data.roles.map(r => {
              const n = data.users.filter(u => u.role === r).length;
              return (
                <label key={r} style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-start',
                  marginBottom: 'var(--s2)' }}>
                  <input type="checkbox" style={{ width: 'auto', minHeight: 0, marginTop: 3 }}
                    checked={draft.roles.includes(r)}
                    onChange={() => setDraft({ ...draft, roles: toggle(draft.roles, r) })} />
                  <span>
                    <strong>{r}</strong> — {ROLE_PERMITS[r]}
                    <span className="hint"> {n} in the registry today</span>
                  </span>
                </label>
              );
            })}
            <p className="hint">Membership follows the role: claim one and everyone holding it joins,
              now and in future. Several groups may claim the same role, and a person can be in all
              of them.</p>
          </fieldset>

          <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 var(--s4)' }}>
            <legend style={{ padding: 0 }}>Notify on</legend>
            {data.events.map(ev => (
              <label key={ev} style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-start',
                marginBottom: 'var(--s2)' }}>
                <input type="checkbox" style={{ width: 'auto', minHeight: 0, marginTop: 3 }}
                  checked={draft.notify_events.includes(ev)}
                  onChange={() => setDraft({ ...draft, notify_events: toggle(draft.notify_events, ev) })} />
                <span>{EVENT_LABEL[ev] ?? ev}</span>
              </label>
            ))}
            <p className="hint">These are the events this server actually emits. Nothing else is offered,
              because a subscription that could never fire is worse than none.</p>
          </fieldset>

          <Feedback error={write.error} note={write.note} />
          <button className="btn btn-primary" type="submit"
            disabled={write.busy || STATIC_DEMO || !draft.name.trim() || !draft.team.trim()}>
            {write.busy ? 'Saving…' : editing ? 'Save changes' : 'Create group'}
          </button>
          {editing && <> <button className="btn" type="button" onClick={cancel}>Cancel</button></>}
          {demoNote && <p className="hint">{demoNote}</p>}
        </form>
      </Panel>
    </>
  );
}

/* ----------------------------------------------------------------- users -- */

const BLANK_USER = { name: '', email: '', role: 'viewer' as Role, notify: true };

function UserSection({ data, reload }: { data: SettingsPayload; reload: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(BLANK_USER);
  const write = useWrite(reload);

  function edit(u: RegistryUser) {
    setEditing(u.id);
    setDraft({ name: u.name, email: u.email, role: u.role, notify: u.notify });
    write.clear();
  }

  function cancel() { setEditing(null); setDraft(BLANK_USER); write.clear(); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: draft.name.trim(), email: draft.email.trim(), role: draft.role, notify: draft.notify,
    };
    const done = editing
      ? await write.run(() => putJson(`/api/settings/users/${editing}`, body), () => `Updated ${body.email}.`)
      : await write.run(() => postJson('/api/settings/users', body), () => `Added ${body.email}.`);
    if (done) cancel();
  }

  async function remove(u: RegistryUser) {
    await write.run(() => deleteJson(`/api/settings/users/${u.id}`), () => `Removed ${u.email}.`);
  }

  /** Says plainly whether this person will actually be emailed, and why not. */
  function reach(u: RegistryUser) {
    if (!u.notify) return <span className="chip dashed">muted by choice</span>;
    const mine = groupsOf(u, data.groups);
    if (mine.length === 0) {
      return <span className="chip dashed">no group claims {u.role}</span>;
    }
    if (!mine.some(g => g.notify_events.length > 0)) {
      return <span className="chip dashed">groups notify on nothing</span>;
    }
    if (!data.mail_configured) return <span className="chip warning">mail not configured</span>;
    return <span className="chip healthy">will be emailed</span>;
  }

  /** Where the role puts them. This is the only place group membership appears. */
  function groupCell(u: RegistryUser) {
    const mine = groupsOf(u, data.groups);
    if (mine.length === 0) return <Absent>none — no group claims {u.role}</Absent>;
    return mine.map(g => (
      <span key={g.id} className="chip" style={{ marginRight: 'var(--s1)' }}>{g.name}</span>
    ));
  }

  // What choosing this role in the form will do, said before the user commits.
  const wouldJoin = data.groups.filter(g => g.roles.includes(draft.role));

  return (
    <>
      <Panel title="Registry" aside={<span className="hint">{data.users.length} people</span>}>
        {data.users.length === 0 ? (
          <EmptyState title="Nobody in the registry yet">
            <p>Add the people who should hear about approvals. Their role decides which groups they
              land in — there is nothing to file by hand. This is a notification registry, not a
              login: the panel has no sign-in.</p>
          </EmptyState>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Role</th><th>What that role does</th>
                  <th>Groups (from role)</th><th>Reach</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.users.map(u => (
                  <tr key={u.id}>
                    <td><strong>{u.name}</strong></td>
                    <td className="mono">{u.email}</td>
                    <td>{u.role}</td>
                    <td>{ROLE_PERMITS[u.role]}</td>
                    <td>{groupCell(u)}</td>
                    <td>{reach(u)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn" onClick={() => edit(u)} disabled={STATIC_DEMO}>Edit</button>{' '}
                      <button className="btn btn-danger" onClick={() => remove(u)}
                        disabled={write.busy || STATIC_DEMO}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={editing ? 'Edit user' : 'Add user'}>
        <form onSubmit={submit}>
          <div className="row-2">
            <div className="field">
              <label htmlFor="u-name">Name</label>
              <input id="u-name" value={draft.name} required
                onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Alex Fry" />
            </div>
            <div className="field">
              <label htmlFor="u-email">Email</label>
              <input id="u-email" type="email" value={draft.email} required
                onChange={e => setDraft({ ...draft, email: e.target.value })} placeholder="alex@example.com" />
            </div>
          </div>

          <div className="field">
            <label htmlFor="u-role">Role</label>
            <select id="u-role" value={draft.role}
              onChange={e => setDraft({ ...draft, role: e.target.value as Role })}>
              {data.roles.map(r => <option key={r} value={r}>{r} — {ROLE_PERMITS[r]}</option>)}
            </select>
            {/* There is no group field: the role is the group. Say where they land
                before the form is submitted, so nothing happens invisibly. */}
            <p className="hint">
              {wouldJoin.length === 0
                ? `No group claims ${draft.role} yet, so this person will be recorded but not emailed. ` +
                  'Claim the role on a group to change that.'
                : `Joins ${wouldJoin.map(g => g.name).join(', ')} — every group that claims ${draft.role}.`}
            </p>
          </div>

          <div className="field">
            <label style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center', marginBottom: 0 }}>
              <input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={draft.notify}
                onChange={e => setDraft({ ...draft, notify: e.target.checked })} />
              <span>Send this person their groups' notifications</span>
            </label>
          </div>

          <Feedback error={write.error} note={write.note} />
          <button className="btn btn-primary" type="submit"
            disabled={write.busy || STATIC_DEMO || !draft.name.trim() || !draft.email.trim()}>
            {write.busy ? 'Saving…' : editing ? 'Save changes' : 'Add user'}
          </button>
          {editing && <> <button className="btn" type="button" onClick={cancel}>Cancel</button></>}
          {demoNote && <p className="hint">{demoNote}</p>}
        </form>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ shell -- */

export function Configuration() {
  const settings = usePoll<SettingsPayload>('/api/settings', 30000);
  const [section, setSection] = useState<Section>('mail');

  // Remounts each section's form when the server data arrives, so the fields
  // start from what is actually stored rather than from an empty first render.
  const [stamp, setStamp] = useState(0);
  useEffect(() => { if (settings.data) setStamp(s => s + 1); }, [settings.data?.mail?.updated_at]);

  if (settings.loading && !settings.data) return <Loading what="configuration" />;
  if (settings.error && !settings.data) return <ErrorState what="configuration" error={settings.error} />;
  const data = settings.data!;

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Configuration sections">
        {SECTIONS.map(s => (
          <button key={s.id} role="tab" aria-selected={section === s.id}
            className={section === s.id ? 'is-on' : undefined}
            onClick={() => setSection(s.id)}>
            {s.label}
            {s.id === 'users' && data.users.length > 0 && <span className="pip">{data.users.length}</span>}
          </button>
        ))}
      </div>

      {section === 'mail' && <MailSection key={stamp} data={data} reload={settings.reload} />}
      {section === 'groups' && <GroupSection data={data} reload={settings.reload} />}
      {section === 'users' && <UserSection data={data} reload={settings.reload} />}

      <p className="hint" style={{ marginTop: 'var(--s5)' }}>
        Stored server-side at <code className="mono">{data.settings_path}</code>. The SMTP password is
        written there and nowhere else — keep that path out of version control.
      </p>
    </>
  );
}
