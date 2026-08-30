// Appends one step to the agent's run log. The agent calls this as it works, so
// the dashboard reflects what actually happened rather than a backfill typed in
// afterwards.
//
// The honesty rule is enforced here, at the point of writing: a measure the
// agent did not take is written as null, never as 0. The dashboard renders null
// as "not recorded yet" — a 0 would be a lie that looks like data.
//
// Usage:
//   node scripts/log-step.mjs --ticket TRDV2-600 --phase RG-Dev \
//     --step "solution doc mailed for review" --gate RG-Dev --verdict pending
//
// Options: --ticket --phase --step --gate --verdict --note --pr-url --ci-state
//          --solution-commit --run-id --agent --model --session
//          --tokens-in --tokens-out --cost --context-pct
//          --log <path>   (default public/data/run-log.jsonl)
//          --dry-run      print the line without appending

import { appendFileSync, readFileSync } from 'node:fs';

const VERDICTS = ['pass', 'approved', 'bounced', 'blocked', 'escalated', 'pending'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const arg = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const die = m => { console.error('ERROR:', m); process.exit(1); };

// A number the agent measured, or null. "0" is a real measurement and survives;
// an absent flag becomes null so nothing invents a zero.
const num = name => {
  const v = arg(name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : die(`--${name} must be a number, got "${v}"`);
};

const ticket = arg('ticket');
const step = arg('step');
if (!ticket) die('--ticket is required (e.g. TRDV2-600)');
if (!step) die('--step is required — say what happened, in a few words');

const gate = arg('gate');
const verdict = arg('verdict');
if (verdict && !VERDICTS.includes(verdict)) die(`--verdict must be one of ${VERDICTS.join(', ')}`);
if (verdict && !gate) die('--verdict only means something with --gate');

// solution_commit is the commit an approval was PINNED TO — the dashboard labels
// it "Approved solution". Writing it when the doc is merely committed would show
// an approval that never happened, so it is only accepted alongside one.
if (arg('solution-commit') && verdict !== 'approved') {
  die('--solution-commit records what was APPROVED; pass it with --gate <G> --verdict approved, ' +
      'or put the commit in --note if you only mean "this is what I committed"');
}

const logPath = arg('log') || 'public/data/run-log.jsonl';

const entry = {
  ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  run_id: arg('run-id') || 'r-session-02',
  agent_name: arg('agent') || 'A',
  claude_session_id: arg('session'),
  model: arg('model') || 'claude-opus-5',
  ticket_key: ticket,
  phase: arg('phase'),
  step,
  tokens_in: num('tokens-in'),
  tokens_out: num('tokens-out'),
  cost_usd: num('cost'),
  context_pct: num('context-pct'),
  gate,
  verdict,
  note: arg('note'),
  pr_url: arg('pr-url'),
  ci_state: arg('ci-state'),
  solution_commit: arg('solution-commit'),
  source: 'agent',
};

const line = JSON.stringify(entry);

if (dryRun) {
  console.log(line);
  console.log('\nDRY RUN — not appended.');
  process.exit(0);
}

// Refuse to append to a file whose last line is already broken, rather than
// adding a good line after a bad one and hiding the damage.
try {
  const existing = readFileSync(logPath, 'utf8').trimEnd();
  if (existing) {
    const last = existing.slice(existing.lastIndexOf('\n') + 1);
    try { JSON.parse(last); } catch { die(`the last line of ${logPath} is not valid JSON — fix it before appending`); }
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;   // a missing log is fine; we create it
}

appendFileSync(logPath, line + '\n');
console.log(`logged ${ticket}${gate ? ` [${gate}${verdict ? ' ' + verdict : ''}]` : ''}: ${step}`);
