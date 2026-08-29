'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FileTeamStore, TeamError, ROUTABLE_GATES } = require('../src/team');

const store = () => new FileTeamStore(
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-team-')), 'team.json'));

/** A store seeded with two active people, returned with their ids. */
function withPeople() {
  const s = store();
  const a = s.addPerson({ name: 'Reviewer A', email: 'a@example.com' });
  const b = s.addPerson({ name: 'Reviewer B', email: 'b@example.com' });
  return { s, a, b };
}

test('a fresh store is empty and every routable gate is uncovered', () => {
  const st = store().state();
  assert.deepStrictEqual(st.people, []);
  assert.deepStrictEqual(st.groups, []);
  assert.deepStrictEqual(st.unassigned_gates, ROUTABLE_GATES);
  for (const g of ROUTABLE_GATES) assert.strictEqual(st.coverage[g], null);
});

test('adds a person and normalises the email', () => {
  const s = store();
  const p = s.addPerson({ name: '  Kalimuthu ', email: 'KALI@Example.com ' });
  assert.strictEqual(p.name, 'Kalimuthu');
  assert.strictEqual(p.email, 'kali@example.com');
  assert.strictEqual(p.active, true);
});

test('rejects a bad email and a duplicate email', () => {
  const s = store();
  assert.throws(() => s.addPerson({ name: 'X', email: 'not-an-email' }), /valid email/);
  s.addPerson({ name: 'One', email: 'dup@example.com' });
  assert.throws(() => s.addPerson({ name: 'Two', email: 'DUP@example.com' }),
    e => e instanceof TeamError && e.code === 'DUPLICATE');
});

test('a group owns a gate and coverage reflects it', () => {
  const { s, a, b } = withPeople();
  const g = s.addGroup({ name: 'Developers', type: 'dev', owns_gate: 'RG-Dev', members: [a.id, b.id] });
  assert.strictEqual(g.owns_gate, 'RG-Dev');
  const st = s.state();
  assert.strictEqual(st.coverage['RG-Dev'], g.id);
  assert.ok(!st.unassigned_gates.includes('RG-Dev'));
  assert.strictEqual(st.groups[0].active_members, 2);
});

test('a gate can be owned by only ONE group', () => {
  const { s, a } = withPeople();
  s.addGroup({ name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id] });
  assert.throws(
    () => s.addGroup({ name: 'Other', type: 'dev', owns_gate: 'RG-Dev', members: [a.id] }),
    e => e instanceof TeamError && e.code === 'GATE_TAKEN');
});

test('a group owning a gate cannot be empty of active members', () => {
  const s = store();
  assert.throws(
    () => s.addGroup({ name: 'Empty', type: 'dev', owns_gate: 'RG-Dev', members: [] }),
    e => e instanceof TeamError && e.code === 'EMPTY_OWNER');
});

test('a distribution-list address satisfies the owner even with no members', () => {
  const s = store();
  const g = s.addGroup({ name: 'DL', type: 'dev', owns_gate: 'RG-Dev', group_email: 'devs@example.com', members: [] });
  assert.strictEqual(g.group_email, 'devs@example.com');
  assert.deepStrictEqual(s.resolveRecipients('RG-Dev').recipients, ['devs@example.com']);
});

test('Security is forced to active-review even if delegation is requested', () => {
  const { s, a } = withPeople();
  const g = s.addGroup({
    name: 'Security', type: 'security', owns_gate: 'RG-Sec',
    members: [a.id], approval_mode: 'standing-delegation',
  });
  assert.strictEqual(g.approval_mode, 'active-review');
});

test('escalation may only contain group members, with positive timeouts', () => {
  const { s, a, b } = withPeople();
  const outsider = s.addPerson({ name: 'C', email: 'c@example.com' });
  assert.throws(() => s.addGroup({
    name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id],
    escalation_order: [{ person_id: outsider.id, timeout_hours: 24 }],
  }), /group members/);
  assert.throws(() => s.addGroup({
    name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id],
    escalation_order: [{ person_id: a.id, timeout_hours: 0 }],
  }), /positive timeout/);
  const g = s.addGroup({
    name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id, b.id],
    escalation_order: [{ person_id: a.id, timeout_hours: 24 }, { person_id: b.id, timeout_hours: 48 }],
  });
  assert.strictEqual(g.escalation_order.length, 2);
});

test('resolveRecipients mails members, skips inactive ones, and reports no owner honestly', () => {
  const { s, a, b } = withPeople();
  s.addGroup({ name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id, b.id] });
  assert.deepStrictEqual(
    s.resolveRecipients('RG-Dev').recipients.sort(), ['a@example.com', 'b@example.com']);

  s.updatePerson(b.id, { active: false });
  assert.deepStrictEqual(s.resolveRecipients('RG-Dev').recipients, ['a@example.com']);

  const none = s.resolveRecipients('G4');
  assert.strictEqual(none.group, null);
  assert.deepStrictEqual(none.recipients, []);
  assert.match(none.reason, /no group/);
});

test('isMember gates approval replies to the owning group only', () => {
  const { s, a } = withPeople();
  s.addGroup({ name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id] });
  assert.strictEqual(s.isMember('RG-Dev', 'A@example.com'), true);
  assert.strictEqual(s.isMember('RG-Dev', 'stranger@example.com'), false);
});

test('deactivating the last active member starves the owned gate (state flags it)', () => {
  const { s, a } = withPeople();
  s.addGroup({ name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id] });
  s.updatePerson(a.id, { active: false });
  const st = s.state();
  assert.ok(st.starved_gates.includes('RG-Dev'));
});

test('updateGroup can reassign members and change the gate', () => {
  const { s, a, b } = withPeople();
  const g = s.addGroup({ name: 'Devs', type: 'dev', owns_gate: 'RG-Dev', members: [a.id] });
  const updated = s.updateGroup(g.id, { owns_gate: 'RG-Ver', members: [a.id, b.id] });
  assert.strictEqual(updated.owns_gate, 'RG-Ver');
  assert.strictEqual(updated.members.length, 2);
  assert.strictEqual(s.state().coverage['RG-Dev'], null);
  assert.strictEqual(s.state().coverage['RG-Ver'], g.id);
});
