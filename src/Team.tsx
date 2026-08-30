import { useEffect, useMemo, useState } from 'react';
import { loadTeamJson, loadTeamMd } from './data';
import { renderMarkdown } from './md';
import { ROUTABLE_GATES } from './runlog';
import { ErrorState, Loading, Panel } from './ui';
import type { Group, TeamConfig } from './types';

/* The Team & mail surface.
 *
 * There is no backend, so this cannot save. It EDITS a draft in the browser and
 * hands back a team.json to commit — the commit is what makes a change real, and
 * is also the audit trail of who changed a recipient and when. Everything below
 * is explicit that a draft is not yet in effect; nothing here ever implies the
 * agent has picked a change up.
 *
 * The draft is kept in localStorage so a reload does not lose work in progress.
 * It is a convenience only — the agent never reads it and cannot. */

const DRAFT_KEY = 'agent.team.draft';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clone = (c: TeamConfig): TeamConfig => JSON.parse(JSON.stringify(c));
const canon = (c: TeamConfig) => JSON.stringify(c);

/** Serialise exactly as the file should look on disk. */
const toFile = (c: TeamConfig) => JSON.stringify(c, null, 2) + '\n';

function readDraft(): TeamConfig | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as TeamConfig) : null;
  } catch { return null; }
}

function writeDraft(c: TeamConfig | null) {
  try {
    if (c) localStorage.setItem(DRAFT_KEY, JSON.stringify(c));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* private window, or storage disabled — editing still works */ }
}

/* ---------- problems the agent would hit ----------
 * Reported here rather than at send time, because a routing mistake is silent:
 * a gate with no recipient does not bounce, it simply never reaches anyone. */

function problems(cfg: TeamConfig) {
  const out: { level: 'error' | 'warn'; text: string }[] = [];
  const groups = cfg.groups ?? [];
  const people = cfg.people ?? [];
  const known = new Set(people.map(p => p.email.toLowerCase()).filter(Boolean));

  if (!cfg.from?.trim()) out.push({ level: 'error', text: 'No sending mailbox — set "from", or no mail can leave.' });
  else if (!EMAIL_RE.test(cfg.from)) out.push({ level: 'error', text: `Sending mailbox "${cfg.from}" is not a valid address.` });

  for (const g of groups) {
    if (!g.emails?.length) out.push({ level: 'error', text: `${g.name || 'unnamed group'} (${g.gate ?? 'no gate'}) has no recipients — its approvals reach nobody.` });
    for (const e of g.emails ?? []) {
      if (!EMAIL_RE.test(e)) out.push({ level: 'error', text: `"${e}" in ${g.name} is not a valid address.` });
      else if (!known.has(e.toLowerCase())) out.push({ level: 'warn', text: `${e} is a recipient of ${g.name} but is not listed under People.` });
    }
  }
  const uncovered = ROUTABLE_GATES.filter(g => !groups.some(x => x.gate === g));
  for (const g of uncovered) out.push({ level: 'warn', text: `${g} has no group — the agent must escalate to a human instead of treating it as passed.` });

  const seen = new Set<string>();
  for (const g of groups) {
    if (!g.gate) continue;
    if (seen.has(g.gate)) out.push({ level: 'error', text: `Two groups both claim ${g.gate} — which one is mailed is undefined.` });
    seen.add(g.gate);
  }
  return out;
}

/* ---------- coverage strip ---------- */

function Coverage({ cfg }: { cfg: TeamConfig }) {
  const groups = cfg.groups ?? [];
  return (
    <div className="gatestrip" role="list" aria-label="gate coverage">
      {ROUTABLE_GATES.map(gate => {
        const owner = groups.find(g => g.gate === gate);
        const recipients = owner?.emails?.filter(Boolean).length ?? 0;
        const cls = !owner ? 's-blocked' : recipients === 0 ? 's-waiting' : 's-clear';
        return (
          <div key={gate} role="listitem" className={`gate ${cls}`}
            title={!owner ? 'no group owns this gate — approval requests go nowhere'
              : recipients === 0 ? 'group has no recipients listed'
              : `${owner.name}: ${owner.emails!.join(', ')}`}>
            <span className="g-name">{gate}</span>
            <span className="g-verdict">{owner ? (recipients === 0 ? 'no recipients' : owner.name) : 'unassigned'}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- editor ---------- */

export function Team() {
  const [committed, setCommitted] = useState<TeamConfig | null>(null);
  const [cfg, setCfg] = useState<TeamConfig | null>(null);
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadTeamJson(), loadTeamMd().catch(() => '')])
      .then(([json, text]) => {
        if (!alive) return;
        setCommitted(json);
        setMd(text);
        const draft = readDraft();
        setCfg(draft ?? clone(json));
      })
      .catch(err => { if (alive) setError(err as Error); });
    return () => { alive = false; };
  }, []);

  const dirty = !!(cfg && committed && canon(cfg) !== canon(committed));
  const issues = useMemo(() => (cfg ? problems(cfg) : []), [cfg]);
  const errors = issues.filter(i => i.level === 'error');

  function update(fn: (d: TeamConfig) => void) {
    setCfg(prev => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      writeDraft(next);
      setCopied(false);
      return next;
    });
  }

  function download() {
    if (!cfg) return;
    const blob = new Blob([toFile(cfg)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'team.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    if (!cfg) return;
    try { await navigator.clipboard.writeText(toFile(cfg)); setCopied(true); }
    catch { setCopied(false); }
  }

  function revert() {
    if (!committed) return;
    setCfg(clone(committed));
    writeDraft(null);
    setCopied(false);
  }

  if (error) return <ErrorState what="the routing file (data/team.json)" error={error} />;
  if (!cfg || !committed) return <Loading what="team" />;

  const people = cfg.people ?? [];
  const groups = cfg.groups ?? [];

  return (
    <>
      {/* The draft banner. This is the one thing that must never be ambiguous:
          an edit here has NOT reached the agent until the file is committed. */}
      {dirty && (
        <div role="status" style={{
          border: '1px solid var(--warning)', background: 'var(--warning-dim)',
          borderRadius: 'var(--radius-sm)', padding: 'var(--s3) var(--s4)',
          marginBottom: 'var(--s4)', fontSize: 'var(--t-sm)',
          display: 'flex', alignItems: 'center', gap: 'var(--s3)', flexWrap: 'wrap',
        }}>
          <b>Draft — not in effect.</b>
          <span>The agent still uses the committed file. Download <span className="mono">team.json</span>,
            replace <span className="mono">public/data/team.json</span>, and commit it.</span>
          <span className="grow" />
          <button className="btn" onClick={revert}>Discard draft</button>
        </div>
      )}

      <Panel title="Gate coverage" aside={<span className="hint">{dirty ? 'showing your draft' : 'from data/team.json'}</span>}>
        <Coverage cfg={cfg} />
      </Panel>

      {issues.length > 0 && (
        <div style={{ marginTop: 'var(--s5)' }}>
          <Panel title={`${issues.length} thing${issues.length === 1 ? '' : 's'} to fix`}>
            <ul className="md-ul">
              {issues.map((p, i) => (
                <li key={i}>
                  <span className={`chip ${p.level === 'error' ? 'critical' : 'warning'}`}>{p.level}</span>{' '}{p.text}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      {/* ---- sending mailbox + Entra identifiers ---- */}
      <div style={{ marginTop: 'var(--s5)' }}>
        <Panel title="Sending account">
          <div className="formrow">
            <label className="field">
              <span>From (mailbox the agent sends as)</span>
              <input value={cfg.from ?? ''} placeholder="agent@yourdomain.com"
                onChange={e => update(d => { d.from = e.target.value; })} />
            </label>
            <label className="field">
              <span>Entra tenant ID</span>
              <input className="mono" value={cfg.graph?.tenantId ?? ''} placeholder="00000000-0000-0000-0000-000000000000"
                onChange={e => update(d => { d.graph = { ...d.graph, tenantId: e.target.value }; })} />
            </label>
            <label className="field">
              <span>Entra client (application) ID</span>
              <input className="mono" value={cfg.graph?.clientId ?? ''} placeholder="00000000-0000-0000-0000-000000000000"
                onChange={e => update(d => { d.graph = { ...d.graph, clientId: e.target.value }; })} />
            </label>
          </div>
          <p className="hint" style={{ marginTop: 'var(--s3)' }}>
            Tenant and client IDs are identifiers, not secrets, so they belong in the file. The
            {' '}<b>client secret never does</b> — it is read at send time from the environment, the
            {' '}macOS Keychain, or <span className="mono">~/.config/agent/graph.env</span>, and there is
            {' '}no field for it here on purpose.
          </p>
        </Panel>
      </div>

      {/* ---- people ---- */}
      <div style={{ marginTop: 'var(--s5)' }}>
        <Panel title="People" aside={
          <button className="btn" onClick={() => update(d => {
            d.people = [...(d.people ?? []), { name: '', email: '', active: true }];
          })}>Add person</button>
        }>
          {people.length === 0
            ? <p className="hint">Nobody listed yet.</p>
            : people.map((p, i) => (
              <div key={i} className="formrow" style={{ alignItems: 'end', marginBottom: 'var(--s3)' }}>
                <label className="field">
                  <span>Name</span>
                  <input value={p.name} onChange={e => update(d => { d.people![i].name = e.target.value; })} />
                </label>
                <label className="field">
                  <span>Email</span>
                  <input value={p.email} placeholder="name@certainti.ai"
                    onChange={e => update(d => { d.people![i].email = e.target.value; })} />
                </label>
                <label className="field" style={{ flex: '0 0 auto' }}>
                  <span>Active</span>
                  <input type="checkbox" checked={p.active !== false}
                    onChange={e => update(d => { d.people![i].active = e.target.checked; })} />
                </label>
                <button className="btn btn-danger" onClick={() => update(d => { d.people!.splice(i, 1); })}>Remove</button>
              </div>
            ))}
        </Panel>
      </div>

      {/* ---- groups ---- */}
      <div style={{ marginTop: 'var(--s5)' }}>
        <Panel title="Gate routing" aside={
          <button className="btn" onClick={() => update(d => {
            d.groups = [...(d.groups ?? []), { name: '', gate: undefined, emails: [], mode: 'active-review' }];
          })}>Add group</button>
        }>
          {groups.length === 0
            ? <p className="hint">No groups — every gate would reach nobody.</p>
            : groups.map((g, i) => (
              <div key={i} style={{
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                padding: 'var(--s3)', marginBottom: 'var(--s3)',
              }}>
                <div className="formrow" style={{ alignItems: 'end' }}>
                  <label className="field">
                    <span>Group name</span>
                    <input value={g.name} placeholder="Developers"
                      onChange={e => update(d => { d.groups![i].name = e.target.value; })} />
                  </label>
                  <label className="field">
                    <span>Gate</span>
                    <select value={g.gate ?? ''} onChange={e => update(d => { d.groups![i].gate = e.target.value || undefined; })}>
                      <option value="">— none —</option>
                      {ROUTABLE_GATES.map(x => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Mode</span>
                    <select value={g.mode ?? 'active-review'}
                      onChange={e => update(d => { d.groups![i].mode = e.target.value as Group['mode']; })}>
                      <option value="active-review">active-review — must reply APPROVED</option>
                      <option value="standing-delegation">standing-delegation — pre-agreed</option>
                    </select>
                  </label>
                  <button className="btn btn-danger" onClick={() => update(d => { d.groups!.splice(i, 1); })}>Remove</button>
                </div>
                <label className="field" style={{ marginTop: 'var(--s3)' }}>
                  <span>Recipients — one address per line</span>
                  <textarea rows={Math.max(2, (g.emails?.length ?? 0) + 1)}
                    value={(g.emails ?? []).join('\n')}
                    placeholder="reviewer@certainti.ai"
                    onChange={e => update(d => {
                      d.groups![i].emails = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
                    })} />
                </label>
              </div>
            ))}
        </Panel>
      </div>

      {/* ---- hand-off ---- */}
      <div style={{ marginTop: 'var(--s5)' }}>
        <Panel title="Apply these changes">
          <p className="hint" style={{ marginBottom: 'var(--s3)' }}>
            This dashboard is a static page with nothing behind it, so it cannot write to the repo.
            {' '}Take the file and commit it — that commit is what the agent reads, and what records
            {' '}the change.
          </p>
          <div style={{ display: 'flex', gap: 'var(--s3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={download} disabled={!dirty}>Download team.json</button>
            <button className="btn" onClick={copy} disabled={!dirty}>{copied ? 'Copied ✓' : 'Copy JSON'}</button>
            {!dirty && <span className="hint">No changes yet — the draft matches the committed file.</span>}
            {dirty && errors.length > 0 && (
              <span className="chip critical">{errors.length} error{errors.length === 1 ? '' : 's'} above — fix before committing</span>
            )}
          </div>
          <p className="hint" style={{ marginTop: 'var(--s3)' }}>
            Replace <span className="mono">public/data/team.json</span>, commit, and push. The push
            {' '}redeploys this page, and the next send uses the new routing.
          </p>
          <details style={{ marginTop: 'var(--s3)' }}>
            <summary className="hint" style={{ cursor: 'pointer' }}>Preview the file</summary>
            <pre className="md-pre"><code>{toFile(cfg)}</code></pre>
          </details>
        </Panel>
      </div>

      {md && (
        <div style={{ marginTop: 'var(--s5)' }}>
          <Panel title="data/team.md — notes">
            <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
          </Panel>
        </div>
      )}
    </>
  );
}
