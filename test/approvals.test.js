'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FileApprovalStore, ApprovalError } = require('../src/approvals');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ap-')), 'approvals.jsonl');
const base = { request_id: 'APP-142:G4', ticket_key: 'APP-142', gate: 'G4', actor: 'alex' };

test('records a decision and reports it as created', () => {
  const s = new FileApprovalStore(tmp());
  const { record, created } = s.decide({ ...base, decision: 'approved' });
  assert.strictEqual(created, true);
  assert.strictEqual(record.decision, 'approved');
  assert.strictEqual(record.channel, 'ui');
  assert.ok(record.ts);
});

test('re-submitting the SAME decision is idempotent, not a duplicate', () => {
  const f = tmp();
  const s = new FileApprovalStore(f);
  s.decide({ ...base, decision: 'approved' });
  const { created } = s.decide({ ...base, decision: 'approved' });
  assert.strictEqual(created, false, 'must not write a second record');
  assert.strictEqual(s.all().length, 1);
});

test('a CONFLICTING second decision is refused and returns the existing one', () => {
  const s = new FileApprovalStore(tmp());
  s.decide({ ...base, decision: 'approved', actor: 'alex' });
  try {
    s.decide({ ...base, decision: 'bounced', reason: 'changed my mind', actor: 'someone-else' });
    assert.fail('expected a CONFLICT');
  } catch (err) {
    assert.ok(err instanceof ApprovalError);
    assert.strictEqual(err.code, 'CONFLICT');
    assert.strictEqual(err.existing.decision, 'approved');
    assert.strictEqual(err.existing.actor, 'alex');
  }
});

test('the email channel and the UI channel share one record — first write wins', () => {
  const f = tmp();
  const s = new FileApprovalStore(f);
  s.decide({ ...base, decision: 'approved', channel: 'email', actor: 'mahitha' });
  // The UI now tries to bounce the same request. It must lose.
  assert.throws(() => s.decide({ ...base, decision: 'bounced', reason: 'no', actor: 'alex' }),
    e => e.code === 'CONFLICT');
  assert.strictEqual(s.find(base.request_id).channel, 'email');
});

test('a bounce without a reason is refused', () => {
  const s = new FileApprovalStore(tmp());
  assert.throws(() => s.decide({ ...base, decision: 'bounced' }),
    e => e.code === 'REASON_REQUIRED');
  assert.throws(() => s.decide({ ...base, decision: 'bounced', reason: '   ' }),
    e => e.code === 'REASON_REQUIRED');
});

test('an approval with no actor is refused — it would not be an audit record', () => {
  const s = new FileApprovalStore(tmp());
  assert.throws(() => s.decide({ ...base, actor: '', decision: 'approved' }),
    e => e.code === 'BAD_REQUEST');
});

test('an unknown decision verb is refused', () => {
  const s = new FileApprovalStore(tmp());
  assert.throws(() => s.decide({ ...base, decision: 'maybe' }), e => e.code === 'BAD_REQUEST');
});

test('a missing approvals file reads as empty, not as an error', () => {
  const s = new FileApprovalStore(path.join(os.tmpdir(), 'acp-none', 'approvals.jsonl'));
  assert.deepStrictEqual(s.all(), []);
  assert.strictEqual(s.find('anything'), null);
});
