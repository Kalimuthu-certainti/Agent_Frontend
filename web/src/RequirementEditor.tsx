import { useState } from 'react';
import { ApiError, postJson, usePoll } from './api';
import type { AgentsPayload, Config } from './types';
import { Loading, Panel } from './ui';

/**
 * Creates a requirement straight into Jira. If Jira is not configured on the
 * server the form says so up front and the submit stays disabled — it does not
 * present a working-looking form that fails on click.
 */
export function RequirementEditor() {
  const cfg = usePoll<Config>('/api/config', 30000);
  const agents = usePoll<AgentsPayload>('/api/agents', 10000);

  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const [eligible, setEligible] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);

  if (cfg.loading || !cfg.data) return <Loading what="configuration" />;

  const configured = cfg.data.jira_configured;
  // A ticket an agent is mid-way through: editing it forces a DoR re-check.
  const inProgress = (agents.data?.agents ?? [])
    .map(a => a.ticket_key).filter(Boolean) as string[];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setResult(null); setMissing(null);
    try {
      const res = await postJson<{ issue: { key: string } }>('/api/requirements', {
        summary: summary.trim(), description: description.trim() || undefined,
        issue_type: issueType, agent_eligible: eligible, ready_for_dev: ready,
      });
      setResult(res.issue.key);
      setSummary(''); setDescription('');
    } catch (e2) {
      const api = e2 as ApiError;
      setErr(api.message);
      if (api.payload?.missing) setMissing(api.payload.missing);
    } finally { setBusy(false); }
  }

  const collision = inProgress.find(t =>
    summary.trim().length > 2 && summary.toUpperCase().includes(t.toUpperCase()));

  return (
    <div style={{ maxWidth: 720 }}>
      {!configured && (
        <div className="state is-error" style={{ textAlign: 'left', padding: 'var(--s4)', marginBottom: 'var(--s5)' }}>
          <h3>Jira is not configured on this server</h3>
          <p style={{ margin: '0 0 var(--s2)' }}>
            The form below is disabled rather than shown as working. Set these on the server and restart:
          </p>
          <pre>{`JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=…            # an Atlassian API token
JIRA_PROJECT_KEY=TRDV2`}</pre>
        </div>
      )}

      <Panel title="New requirement">
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="summary">Summary</label>
            <input id="summary" value={summary} required disabled={!configured}
              onChange={e => setSummary(e.target.value)}
              placeholder="What needs to change, in one line" />
          </div>

          <div className="field">
            <label htmlFor="desc">Description</label>
            <textarea id="desc" rows={7} value={description} disabled={!configured}
              onChange={e => setDescription(e.target.value)}
              placeholder={'Background\nAcceptance criteria — each one testable\nOut of scope'} />
            <p className="hint">Acceptance criteria that are not testable will bounce at DoR, so it is
              cheaper to write them properly here.</p>
          </div>

          <div className="field">
            <label htmlFor="type">Issue type</label>
            <select id="type" value={issueType} disabled={!configured}
              onChange={e => setIssueType(e.target.value)}>
              <option>Task</option><option>Bug</option><option>Story</option>
            </select>
          </div>

          <div className="field" style={{ display: 'flex', gap: 'var(--s5)' }}>
            <label style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center', marginBottom: 0 }}>
              <input type="checkbox" checked={eligible} disabled={!configured} style={{ width: 'auto', minHeight: 0 }}
                onChange={e => setEligible(e.target.checked)} />
              <span>Label <code className="mono">agent-eligible</code></span>
            </label>
            <label style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center', marginBottom: 0 }}>
              <input type="checkbox" checked={ready} disabled={!configured} style={{ width: 'auto', minHeight: 0 }}
                onChange={e => setReady(e.target.checked)} />
              <span>Ready for Dev</span>
            </label>
          </div>

          {collision && (
            <div style={{ border: '2px solid var(--warning)', background: 'var(--warning-dim)',
              borderRadius: 'var(--radius-sm)', padding: 'var(--s3)', marginBottom: 'var(--s4)' }}>
              <strong style={{ color: 'var(--warning)' }}>An agent is working {collision} right now.</strong>
              <p style={{ margin: 'var(--s1) 0 0', fontSize: 'var(--t-sm)' }}>
                Changing a requirement mid-flight forces a Definition-of-Ready re-check. The agent is
                notified at its next step boundary and must re-run DoR against the new text — work already
                done against the old text may be discarded.
              </p>
            </div>
          )}

          {err && (
            <div style={{ color: 'var(--critical)', fontSize: 'var(--t-sm)', marginBottom: 'var(--s3)' }}>
              <p style={{ margin: 0 }}>{err}</p>
              {missing && <p style={{ margin: 'var(--s1) 0 0' }} className="mono">missing: {missing.join(', ')}</p>}
            </div>
          )}
          {result && (
            <p style={{ color: 'var(--healthy)', fontSize: 'var(--t-sm)' }}>
              Created <strong className="mono">{result}</strong>
              {cfg.data.jira_project && ` in ${cfg.data.jira_project}`}.
            </p>
          )}

          <button className="btn btn-primary" type="submit" disabled={!configured || busy || !summary.trim()}>
            {busy ? 'Creating…' : 'Create in Jira'}
          </button>
          {!configured && <p className="hint">Disabled until Jira is configured.</p>}
        </form>
      </Panel>
    </div>
  );
}
