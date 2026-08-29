'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FileTeamStore, TeamError } = require('../src/team');
const { GATE_ORDER } = require('../src/runLog');

const tmpStore = () => new FileTeamStore(
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-')), 'team.json'));

test('a missing file is an empty team, not an error', () => {
  const store = tmpStore();
  assert.deepStrictEqual(store.people(), []);
  assert.deepStrictEqual(store.groups(), []);
  for (const gate of GATE_ORDER) assert.strictEqual(store.coverage()[gate], null);
});

test('person: name and email required, email valid and unique', () => {
  const store = tmpStore();
  assert.throws(() => store.createPerson({ email: 'a@b.co' }), TeamError);
  assert.throws(() => store.createPerson({ name: 'A' }), TeamError);
  assert.throws(() => store.createPerson({ name: 'A', email: 'not-an-email' }), TeamError);

  const a = store.createPerson({ name: 'Mahitha', email: 'Mahitha@Example.com' });
  assert.strictEqual(a.email, 'mahitha@example.com'); // normalised
  assert.strictEqual(a.active, true);                 // default on

  assert.throws(() => store.createPerson({ name: 'B', email: 'mahitha@example.com' }),
    err => err instanceof TeamError && err.code === 'DUPLICATE');
});

test('deactivation is soft — the person stays, member lists keep them', () => {
  const store = tmpStore();
  const p = store.createPerson({ name: 'Priya', email: 'priya@example.com' });
  const g = store.createGroup({ name: 'QA', type: 'qa', member_ids: [p.id] });
  store.updatePerson(p.id, { active: false });
  assert.strictEqual(store.person(p.id).active, false);
  assert.deepStrictEqual(store.group(g.id).member_ids, [p.id]);
  // …but they are never mailed
  store.updateGroup(g.id, { owns_gate: null });
  assert.deepStrictEqual(store.recipients('RG-Test'), null);
});

test('one gate, one owner — assigning a gate moves it', () => {
  const store = tmpStore();
  const p = store.createPerson({ name: 'Nakul', email: 'nakul@example.com' });
  const dev = store.createGroup({ name: 'Developers', type: 'dev', member_ids: [p.id], owns_gate: 'RG-Dev' });
  const other = store.createGroup({ name: 'Platform', type: 'dev', member_ids: [p.id], owns_gate: 'RG-Ver' });

  assert.strictEqual(store.coverage()['RG-Dev'], dev.id);
  store.updateGroup(other.id, { owns_gate: 'RG-Dev' });
  assert.strictEqual(store.coverage()['RG-Dev'], other.id);
  assert.strictEqual(store.group(dev.id).owns_gate, null); // released, atomically
});

test('unknown gates are refused with the build vocabulary', () => {
  const store = tmpStore();
  const p = store.createPerson({ name: 'A', email: 'a@example.com' });
  assert.throws(() => store.createGroup({ name: 'X', type: 'dev', member_ids: [p.id], owns_gate: 'RG-Nope' }),
    /unknown gate/);
});

test('a group write may not leave an owned gate without an active member', () => {
  const store = tmpStore();
  const p = store.createPerson({ name: 'A', email: 'a@example.com' });

  // owning a gate with no members at all: refused
  assert.throws(() => store.createGroup({ name: 'Empty', type: 'dev', owns_gate: 'RG-Dev' }),
    err => err instanceof TeamError && err.code === 'EMPTY_GROUP');

  const g = store.createGroup({ name: 'Dev', type: 'dev', member_ids: [p.id], owns_gate: 'RG-Dev' });
  // removing the last member while still owning: refused
  assert.throws(() => store.updateGroup(g.id, { member_ids: [] }),
    err => err instanceof TeamError && err.code === 'EMPTY_GROUP');

  // deactivating the person is allowed — that is a fact, not a config edit —
  // and the gap then shows in recipients()
  store.updatePerson(p.id, { active: false });
  assert.deepStrictEqual(store.recipients('RG-Dev').emails, []);
});

test('security groups are locked to active review', () => {
  const store = tmpStore();
  const p = store.createPerson({ name: 'A', email: 'a@example.com' });
  assert.throws(() => store.createGroup({
    name: 'Security', type: 'security', member_ids: [p.id], approval_mode: 'standing_delegation',
  }), err => err instanceof TeamError && err.code === 'SECURITY_LOCKED');

  const g = store.createGroup({ name: 'Security', type: 'security', member_ids: [p.id] });
  assert.strictEqual(g.approval_mode, 'active_review');
});

test('escalation rungs must be members with positive timeouts, no duplicates', () => {
  const store = tmpStore();
  const a = store.createPerson({ name: 'A', email: 'a@example.com' });
  const b = store.createPerson({ name: 'B', email: 'b@example.com' });

  assert.throws(() => store.createGroup({
    name: 'Dev', type: 'dev', member_ids: [a.id],
    escalation_order: [{ person_id: b.id, timeout_hours: 24 }],
  }), err => err.code === 'BAD_ESCALATION');

  assert.throws(() => store.createGroup({
    name: 'Dev', type: 'dev', member_ids: [a.id],
    escalation_order: [{ person_id: a.id, timeout_hours: 0 }],
  }), err => err.code === 'BAD_ESCALATION');

  assert.throws(() => store.createGroup({
    name: 'Dev', type: 'dev', member_ids: [a.id],
    escalation_order: [{ person_id: a.id }, { person_id: a.id }],
  }), err => err.code === 'BAD_ESCALATION');

  const g = store.createGroup({
    name: 'Dev', type: 'dev', member_ids: [a.id, b.id],
    escalation_order: [{ person_id: a.id }, { person_id: b.id, timeout_hours: 48 }],
  });
  assert.deepStrictEqual(g.escalation_order, [
    { person_id: a.id, timeout_hours: 24 }, // default
    { person_id: b.id, timeout_hours: 48 },
  ]);
});

test('recipients: DL wins over members; otherwise active members only', () => {
  const store = tmpStore();
  const a = store.createPerson({ name: 'A', email: 'a@example.com' });
  const b = store.createPerson({ name: 'B', email: 'b@example.com', active: false });
  const g = store.createGroup({ name: 'Dev', type: 'dev', member_ids: [a.id, b.id], owns_gate: 'RG-Dev' });

  assert.deepStrictEqual(store.recipients('RG-Dev'),
    { group_id: g.id, group_name: 'Dev', via: 'members', emails: ['a@example.com'] });

  store.updateGroup(g.id, { group_email: 'dev-review@example.com' });
  assert.deepStrictEqual(store.recipients('RG-Dev').emails, ['dev-review@example.com']);
  assert.strictEqual(store.recipients('RG-Dev').via, 'dl');

  assert.strictEqual(store.recipients('DoR'), null); // unowned gate routes nowhere
});

test('knownSender: only the DL or an active member may decide by mail', () => {
  const store = tmpStore();
  const a = store.createPerson({ name: 'A', email: 'a@example.com' });
  const b = store.createPerson({ name: 'B', email: 'b@example.com', active: false });
  store.createGroup({ name: 'Dev', type: 'dev', member_ids: [a.id, b.id], owns_gate: 'RG-Dev' });

  assert.strictEqual(store.knownSender('RG-Dev', 'A@example.com'), true);
  assert.strictEqual(store.knownSender('RG-Dev', 'b@example.com'), false); // inactive
  assert.strictEqual(store.knownSender('RG-Dev', 'stranger@example.com'), false);
  assert.strictEqual(store.knownSender('DoR', 'a@example.com'), false);   // unowned
});

test('a corrupt team file says so instead of resetting the routing', () => {
  const store = tmpStore();
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
  fs.writeFileSync(store.filePath, '{not json');
  assert.throws(() => store.read(), err => err instanceof TeamError && err.code === 'CORRUPT');
});

test('payload carries the server vocabulary and coverage', () => {
  const store = tmpStore();
  const p = store.createPerson({ name: 'A', email: 'a@example.com' });
  const g = store.createGroup({ name: 'Dev', type: 'dev', member_ids: [p.id], owns_gate: 'RG-Dev' });
  const payload = store.payload();
  assert.deepStrictEqual(payload.gate_order, GATE_ORDER);
  assert.strictEqual(payload.coverage['RG-Dev'], g.id);
  assert.strictEqual(payload.coverage['G4'], null);
  assert.ok(payload.group_types.includes('security'));
  assert.ok(payload.approval_modes.includes('active_review'));
});
