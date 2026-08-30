import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';

import { usePoll } from './api';
import type { Config } from './types';
import { CommandDeck } from './CommandDeck';
import { TicketView } from './TicketView';
import { Usage } from './Usage';
import { Approvals } from './Approvals';
import { Team } from './Team';

type SurfaceId = 'deck' | 'ticket' | 'usage' | 'approvals' | 'team';

const SURFACES: { id: SurfaceId; label: string; title: string; lede: string }[] = [
  { id: 'deck', label: 'Command deck', title: 'Command deck',
    lede: 'What every agent is doing right now, and how close each is to handing over.' },
  { id: 'ticket', label: 'Tickets', title: 'Ticket',
    lede: 'Gate progression, timeline and evidence for one ticket. A gate is cleared only when the agent records it as cleared.' },
  { id: 'usage', label: 'Usage & credit', title: 'Usage & credit',
    lede: 'Where tokens and money went. Measures the agent never recorded are withheld, never plotted as zero.' },
  { id: 'approvals', label: 'Approvals', title: 'Approvals',
    lede: 'Gates the agent has recorded as waiting on a human. Read-only — decisions are made over email.' },
  { id: 'team', label: 'Team & mail', title: 'Team & mail routing',
    lede: 'Who is mailed for each gate. Edit it here, then download data/team.json and commit it — the commit is what the agent reads.' },
];

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => { try { return (localStorage.getItem('acp.theme') as 'dark' | 'light') ?? 'dark'; } catch { return 'dark'; } });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('acp.theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return { theme, toggle: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')) };
}

function App() {
  const [surface, setSurface] = useState<SurfaceId>('deck');
  const [ticketKey, setTicketKey] = useState<string | null>(null);
  const { theme, toggle } = useTheme();
  const cfg = usePoll<Config>('/api/config');

  const meta = SURFACES.find(s => s.id === surface)!;
  const openTicket = (k: string) => { setTicketKey(k); setSurface('ticket'); };

  return (
    <div className="shell">
      <nav className="rail" aria-label="Surfaces">
        <div className="rail-brand">
          <div className="name">Agent Control</div>
          <div className="sub">dev-agent programme</div>
        </div>
        <div className="rail-nav">
          {SURFACES.map(s => (
            <button key={s.id} onClick={() => setSurface(s.id)}
              aria-current={surface === s.id ? 'page' : undefined}>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <div className="rail-foot">
          <button className="btn" onClick={toggle} style={{ width: '100%' }}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          <p className="hint" style={{ margin: 0, wordBreak: 'break-all' }}>
            {cfg.data ? <>source <span className="mono">agent files</span></> : 'loading…'}
          </p>
        </div>
      </nav>

      <main className="main">
        <div role="note" style={{
          border: '1px solid var(--border-strong)', background: 'var(--surface-sunk)',
          borderRadius: 'var(--radius)', padding: 'var(--s3) var(--s4)', marginBottom: 'var(--s4)',
          fontSize: 'var(--t-sm)', color: 'var(--ink-2)',
        }}>
          <strong>No backend.</strong> This dashboard shows the agent's work, taken entirely from the
          files it commits — <span className="mono">data/run-log.jsonl</span> and
          {' '}<span className="mono">data/team.json</span>. Every surface here is read-only except
          {' '}<strong>Team &amp; mail</strong>, which edits the routing in your browser and hands back a
          file to commit — nothing is saved to a server, because there is no server.
        </div>

        <header className="main-head">
          <div>
            <h1>{meta.title}</h1>
            <p className="lede">{meta.lede}</p>
          </div>
        </header>

        {surface === 'deck' && <CommandDeck onOpenTicket={openTicket} />}
        {surface === 'ticket' && <TicketView ticketKey={ticketKey} onPick={setTicketKey} />}
        {surface === 'usage' && <Usage />}
        {surface === 'approvals' && <Approvals />}
        {surface === 'team' && <Team />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
