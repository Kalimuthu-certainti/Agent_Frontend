import { useEffect, useState } from 'react';
import { loadTeamMd } from './data';
import { extractJsonBlock, renderMarkdown } from './md';
import { ROUTABLE_GATES } from './runlog';
import { EmptyState, ErrorState, Loading, Panel } from './ui';

/* Read-only. The agent maintains data/team.md; this renders it, and reads the
 * mail routing from a ```json block inside it to draw the gate-coverage strip.
 * Editing the mail is editing that file — the dashboard just shows it. */

interface TeamConfig {
  people?: { name: string; email: string; active?: boolean }[];
  groups?: { name: string; gate?: string; emails?: string[]; mode?: string }[];
}

function Coverage({ cfg }: { cfg: TeamConfig }) {
  const groups = cfg.groups ?? [];
  return (
    <div className="gatestrip" role="list" aria-label="gate coverage">
      {ROUTABLE_GATES.map(gate => {
        const owner = groups.find(g => g.gate === gate);
        const recipients = owner?.emails?.length ?? 0;
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

export function Team() {
  const [md, setMd] = useState<string | null>(null);
  const [cfg, setCfg] = useState<TeamConfig | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let alive = true;
    loadTeamMd()
      .then(text => { if (!alive) return; setMd(text); setCfg(extractJsonBlock<TeamConfig>(text)); })
      .catch(err => { if (alive) setError(err as Error); });
    return () => { alive = false; };
  }, []);

  if (error) return <ErrorState what="the team file (data/team.md)" error={error} />;
  if (md === null) return <Loading what="team" />;

  const uncovered = cfg ? ROUTABLE_GATES.filter(g => !(cfg.groups ?? []).some(x => x.gate === g)) : ROUTABLE_GATES;

  return (
    <>
      {cfg && uncovered.length > 0 && (
        <div role="alert" style={{
          border: '1px solid var(--critical)', background: 'var(--critical-dim)',
          borderRadius: 'var(--radius-sm)', padding: 'var(--s3)', marginBottom: 'var(--s4)', fontSize: 'var(--t-sm)',
        }}>
          <b>{uncovered.length} gate{uncovered.length === 1 ? '' : 's'} unassigned</b> in the file —
          {' '}<span className="mono">{uncovered.join(', ')}</span> route to no one.
        </div>
      )}

      {cfg
        ? <Panel title="Gate coverage — from data/team.md"><Coverage cfg={cfg} /></Panel>
        : <EmptyState title="No routing block found">
            <p>Add a <span className="mono">```json</span> block to <span className="mono">data/team.md</span> with
              {' '}<span className="mono">groups</span> mapping a gate to recipient emails, and it will show here.</p>
          </EmptyState>}

      <div style={{ marginTop: 'var(--s5)' }}>
        <Panel title="data/team.md">
          <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
        </Panel>
      </div>
    </>
  );
}
