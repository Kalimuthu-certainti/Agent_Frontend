import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';

import { STATIC_DEMO, usePoll } from './api';
import type { ApprovalsPayload, Config } from './types';
import { CommandDeck } from './CommandDeck';
import { TicketView } from './TicketView';
import { Usage } from './Usage';
import { Approvals } from './Approvals';
import { RequirementEditor } from './RequirementEditor';

type SurfaceId = 'deck' | 'ticket' | 'usage' | 'approvals' | 'requirement';

const SURFACES: { id: SurfaceId; label: string; title: string; lede: string }[] = [
  { id: 'deck', label: 'Command deck', title: 'Command deck',
    lede: 'What every agent is doing right now, and how close each is to handing over.' },
  { id: 'ticket', label: 'Tickets', title: 'Ticket',
    lede: 'Gate progression, timeline and evidence for one ticket. A gate is cleared only when it is recorded as cleared.' },
  { id: 'usage', label: 'Usage & credit', title: 'Usage & credit',
    lede: 'Where tokens and money went. Measures that were never recorded are withheld rather than plotted as zero.' },
  { id: 'approvals', label: 'Approvals', title: 'Approvals',
    lede: 'Everything waiting on a human decision, with enough context to decide without leaving this screen.' },
  { id: 'requirement', label: 'Requirement', title: 'Requirement editor',
    lede: 'Write a requirement straight into Jira, labelled for agent intake.' },
];

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('acp.theme') as 'dark' | 'light') ?? 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('acp.theme', theme);
  }, [theme]);
  return { theme, toggle: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')) };
}

function App() {
  const [surface, setSurface] = useState<SurfaceId>('deck');
  const [ticketKey, setTicketKey] = useState<string | null>(null);
  const { theme, toggle } = useTheme();
  const approvals = usePoll<ApprovalsPayload>('/api/approvals', 15000);
  const cfg = usePoll<Config>('/api/config', 60000);

  const waiting = approvals.data?.items.filter(i => !i.decision).length ?? 0;
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
              {s.id === 'approvals' && waiting > 0 && <span className="pip">{waiting}</span>}
            </button>
          ))}
        </div>

        <div className="rail-foot">
          <button className="btn" onClick={toggle} style={{ width: '100%' }}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          <p className="hint" style={{ margin: 0, wordBreak: 'break-all' }}>
            {cfg.data ? <>reader <span className="mono">{cfg.data.reader}</span></> : 'connecting…'}
          </p>
        </div>
      </nav>

      <main className="main">
        {STATIC_DEMO && (
          <div role="note" style={{
            border: '1px solid var(--warning)', background: 'var(--warning-dim)',
            borderRadius: 'var(--radius)', padding: 'var(--s3) var(--s4)', marginBottom: 'var(--s4)',
            fontSize: 'var(--t-sm)', color: 'var(--ink)',
          }}>
            <strong>Static demo</strong> — a UI showcase on GitHub Pages with synthetic data. There is no
            backend here: figures don't update, Approve / Bounce are inert, and the requirement editor is
            disabled. The working tool runs the Node server behind these same screens.
          </div>
        )}
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
        {surface === 'requirement' && <RequirementEditor />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
