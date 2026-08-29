'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendStep, buildRecord, RunLogError } = require('../src/runLog');
const { FileRunLogReader, honestSum } = require("../src/reader");

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-')), 'run-log.jsonl');
}

/* ---------- the honesty rule: absent is not zero ---------- */

test('honestSum returns null when nothing was recorded, not 0', () => {
  const { value, recorded } = honestSum([{ cost_usd: null }, { cost_usd: undefined }, {}], 'cost_usd');
  assert.strictEqual(value, null);
  assert.strictEqual(recorded, 0);
});

test('honestSum returns 0 when a real zero WAS recorded', () => {
  const { value, recorded } = honestSum([{ cost_usd: 0 }], 'cost_usd');
  assert.strictEqual(value, 0);
  assert.strictEqual(recorded, 1);
});

test('usage totals are null, not 0, when no step carried cost or tokens', () => {
  const log = tmpLog();
  appendStep({ run_id: 'r1', agent_name: 'A', ticket_key: 'T-1', phase: 'build' }, log);
  const u = new FileRunLogReader(log).usage();
  assert.strictEqual(u.totals.cost_usd, null);
  assert.strictEqual(u.totals.tokens_in, null);
  assert.strictEqual(u.totals.steps, 1);
});

test('omitted fields are stored as null, never defaulted', () => {
  const rec = buildRecord({ run_id: 'r1', agent_name: 'A' });
  assert.strictEqual(rec.tokens_in, null);
  assert.strictEqual(rec.cost_usd, null);
  assert.strictEqual(rec.context_pct, null);
  assert.strictEqual(rec.ticket_key, null);
});

/* ---------- validation: a corrupt log is worse than a missing one ---------- */

test('rejects a record with no run_id or agent', () => {
  assert.throws(() => buildRecord({ agent_name: 'A' }), RunLogError);
  assert.throws(() => buildRecord({ run_id: 'r1' }), RunLogError);
});

test('rejects an unknown gate or verdict', () => {
  assert.throws(() => buildRecord({ run_id: 'r', agent_name: 'A', gate: 'RG-Nope' }), RunLogError);
  assert.throws(() => buildRecord({ run_id: 'r', agent_name: 'A', gate: 'G4', verdict: 'probably' }), RunLogError);
});

test('rejects an out-of-range context_pct', () => {
  assert.throws(() => buildRecord({ run_id: 'r', agent_name: 'A', context_pct: 140 }), RunLogError);
});

/* ---------- reading ---------- */

test('a missing log file reads as empty, not as an error', () => {
  const store = new FileRunLogReader(path.join(os.tmpdir(), 'acp-nonexistent', 'run-log.jsonl'));
  const { rows, exists } = store.readAll();
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(exists, false);
});

test('a malformed line is skipped and counted, not thrown', () => {
  const log = tmpLog();
  appendStep({ run_id: 'r1', agent_name: 'A' }, log);
  fs.appendFileSync(log, 'this is not json\n');
  appendStep({ run_id: 'r2', agent_name: 'B' }, log);
  const { rows, malformed } = new FileRunLogReader(log).readAll();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(malformed, 1);
});

/* ---------- context thresholds ---------- */

test('context thresholds map to nominal / warning / handover at 75 and 90', () => {
  const log = tmpLog();
  appendStep({ run_id: 'r1', agent_name: 'A', context_pct: 74 }, log);
  appendStep({ run_id: 'r2', agent_name: 'B', context_pct: 75 }, log);
  appendStep({ run_id: 'r3', agent_name: 'C', context_pct: 90 }, log);
  const byName = Object.fromEntries(new FileRunLogReader(log).agents().map(a => [a.agent_name, a]));
  assert.strictEqual(byName.A.context_band, 'nominal');
  assert.strictEqual(byName.B.context_band, 'warning');
  assert.strictEqual(byName.C.context_band, 'handover');
});

test('an agent with no context_pct gets a null threshold, not "ok"', () => {
  const log = tmpLog();
  appendStep({ run_id: 'r1', agent_name: 'A' }, log);
  assert.strictEqual(new FileRunLogReader(log).agents()[0].context_band, null);
});

/* ---------- gates ---------- */

test('an unrecorded gate is pending and flagged unrecorded — never a pass', () => {
  const log = tmpLog();
  appendStep({ run_id: 'r1', agent_name: 'A', ticket_key: 'T-1', gate: 'DoR', verdict: 'pass' }, log);
  const [t] = new FileRunLogReader(log).gates();
  const dor = t.gates.find(g => g.gate === 'DoR');
  const g4 = t.gates.find(g => g.gate === 'G4');
  assert.strictEqual(dor.recorded, true);
  assert.strictEqual(dor.verdict, 'pass');
  assert.strictEqual(g4.recorded, false);
  assert.strictEqual(g4.verdict, 'pending');
  assert.strictEqual(t.ready_to_merge, false, 'must not be ready with unrecorded gates');
});

test('a bounced gate marks the ticket blocked', () => {
  const log = tmpLog();
  appendStep({ run_id: 'r1', agent_name: 'A', ticket_key: 'T-1', gate: 'RG-Ver', verdict: 'bounced' }, log);
  const [t] = new FileRunLogReader(log).gates();
  assert.strictEqual(t.blocked, true);
  assert.deepStrictEqual(t.blocking_gates, ['RG-Ver']);
});

test('the latest verdict for a gate wins', () => {
  const log = tmpLog();
  appendStep({ ts: '2026-08-24T10:00:00Z', run_id: 'r1', agent_name: 'A', ticket_key: 'T-1', gate: 'RG-Ver', verdict: 'bounced' }, log);
  appendStep({ ts: '2026-08-24T12:00:00Z', run_id: 'r1', agent_name: 'A', ticket_key: 'T-1', gate: 'RG-Ver', verdict: 'pass' }, log);
  const [t] = new FileRunLogReader(log).gates();
  assert.strictEqual(t.gates.find(g => g.gate === 'RG-Ver').verdict, 'pass');
  assert.strictEqual(t.blocked, false);
});

test('ready_to_merge only when every gate is recorded and clear', () => {
  const log = tmpLog();
  for (const gate of ['DoR', 'RG-TL', 'RG-Dev', 'RG-Test', 'RG-Ver', 'RG-Sec', 'G4']) {
    appendStep({ run_id: 'r1', agent_name: 'A', ticket_key: 'T-1', gate, verdict: 'pass' }, log);
  }
  assert.strictEqual(new FileRunLogReader(log).gates()[0].ready_to_merge, true);
});

/* ---------- runs ---------- */

test('runs returns newest first and reports truncation', () => {
  const log = tmpLog();
  for (let i = 0; i < 5; i++) {
    appendStep({ ts: `2026-08-24T0${i}:00:00Z`, run_id: 'r1', agent_name: 'A', step: `s${i}` }, log);
  }
  const r = new FileRunLogReader(log).runs({ limit: 2 });
  assert.strictEqual(r.rows[0].step, 's4');
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.truncated, true);
});

test('runs filters by ticket', () => {
  const log = tmpLog();
  appendStep({ run_id: 'r1', agent_name: 'A', ticket_key: 'T-1' }, log);
  appendStep({ run_id: 'r2', agent_name: 'A', ticket_key: 'T-2' }, log);
  assert.strictEqual(new FileRunLogReader(log).runs({ ticket_key: 'T-2' }).total, 1);
});

/* ---------- backfill marking ---------- */

test('source defaults to live and only "backfill" overrides it', () => {
  assert.strictEqual(buildRecord({ run_id: 'r', agent_name: 'A' }).source, 'live');
  assert.strictEqual(buildRecord({ run_id: 'r', agent_name: 'A', source: 'backfill' }).source, 'backfill');
  assert.strictEqual(buildRecord({ run_id: 'r', agent_name: 'A', source: 'invented' }).source, 'live');
});
