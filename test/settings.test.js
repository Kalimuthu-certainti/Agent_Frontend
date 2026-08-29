'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FileSettingsStore, SettingsError } = require('../src/settings');

const store = () => new FileSettingsStore(
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-set-')), 'settings.json'));

const MAIL = {
  host: 'smtp.example.com', port: 587, security: 'starttls',
  username: 'bot@example.com', password: 's3cret',
  from_name: 'Agent Control', from_email: 'bot@example.com',
};

/* ---------------- mail ---------------- */

test('no settings file reads as absent, not as an empty configuration', () => {
  const s = store();
  assert.strictEqual(s.mail(), null);
  assert.strictEqual(s.redactedMail(), null);
  assert.strictEqual(s.configured(), false);
  assert.deepStrictEqual(s.groups(), []);
  assert.deepStrictEqual(s.users(), []);
});

test('saving mail returns it redacted and never leaks the password', () => {
  const s = store();
  const saved = s.saveMail(MAIL);
  assert.strictEqual(saved.password, undefined);
  assert.strictEqual(saved.password_set, true);
  assert.strictEqual(saved.host, 'smtp.example.com');
  assert.strictEqual(s.mail().password, 's3cret', 'the mailer still needs the real value');
  assert.strictEqual(s.configured(), true);
});

test('an omitted password keeps the stored one; an empty string clears it', () => {
  const s = store();
  s.saveMail(MAIL);
  s.saveMail({ ...MAIL, password: undefined, username: '' });
  assert.strictEqual(s.mail().password, 's3cret', 'a blind round-trip must not wipe the secret');
  s.saveMail({ ...MAIL, username: '', password: '' });
  assert.strictEqual(s.mail().password, null);
});

test('a username with no password is refused rather than left to fail at AUTH', () => {
  const s = store();
  assert.throws(() => s.saveMail({ ...MAIL, password: '' }), /username needs a password/);
});

test('mail validation rejects bad ports, addresses and security modes', () => {
  const s = store();
  assert.throws(() => s.saveMail({ ...MAIL, host: '' }), /host is required/);
  assert.throws(() => s.saveMail({ ...MAIL, port: 0 }), /between 1 and 65535/);
  assert.throws(() => s.saveMail({ ...MAIL, from_email: 'not-an-address' }), /not a valid email/);
  assert.throws(() => s.saveMail({ ...MAIL, security: 'ssl' }), /security must be one of/);
});

test('a half-set-up server does not report as configured', () => {
  const s = store();
  s.write({ mail: { host: 'smtp.example.com', port: 587, from_email: null }, groups: [], users: [] });
  assert.strictEqual(s.configured(), false);
});

test('a corrupt settings file is an error, not a silent reset to empty', () => {
  const s = store();
  fs.mkdirSync(path.dirname(s.filePath), { recursive: true });
  fs.writeFileSync(s.filePath, '{ not json', 'utf8');
  assert.throws(() => s.read(), err => err instanceof SettingsError && err.code === 'CORRUPT');
});

/* ---------------- groups ---------------- */

test('creates a group and refuses a duplicate name', () => {
  const s = store();
  const g = s.createGroup({ name: 'Platform', team: 'Platform', notify_events: ['approval.recorded'] });
  assert.match(g.id, /^grp_/);
  assert.deepStrictEqual(g.notify_events, ['approval.recorded']);
  assert.throws(() => s.createGroup({ name: 'platform', team: 'Other' }),
    err => err.code === 'DUPLICATE');
});

test('a group needs a team, and cannot subscribe to an event the server never emits', () => {
  const s = store();
  assert.throws(() => s.createGroup({ name: 'X' }), /needs a team/);
  assert.throws(() => s.createGroup({ name: 'X', team: 'T', notify_events: ['ticket.exploded'] }),
    err => err.code === 'UNKNOWN_EVENT' && /this server emits/.test(err.message));
});

test('deleting a group with members is refused and names them', () => {
  const s = store();
  const g = s.createGroup({ name: 'Platform', team: 'Platform' });
  s.createUser({ name: 'Alex', email: 'alex@example.com', group_id: g.id });
  assert.throws(() => s.deleteGroup(g.id), err =>
    err.code === 'GROUP_NOT_EMPTY' && err.members.includes('alex@example.com'));
  s.deleteUser(s.users()[0].id);
  assert.strictEqual(s.deleteGroup(g.id).id, g.id);
});

/* ---------------- users ---------------- */

test('adds a user, lower-cases the address and defaults the role', () => {
  const s = store();
  const u = s.createUser({ name: 'Alex Fry', email: 'Alex@Example.COM' });
  assert.strictEqual(u.email, 'alex@example.com');
  assert.strictEqual(u.role, 'viewer');
  assert.strictEqual(u.notify, true);
  assert.strictEqual(u.group_id, null);
});

test('refuses a duplicate address, a bad address and an unknown role or group', () => {
  const s = store();
  s.createUser({ name: 'Alex', email: 'alex@example.com' });
  assert.throws(() => s.createUser({ name: 'Other', email: 'ALEX@example.com' }),
    err => err.code === 'DUPLICATE');
  assert.throws(() => s.createUser({ name: 'B', email: 'nope' }), /not a valid email/);
  assert.throws(() => s.createUser({ name: 'B', email: 'b@example.com', role: 'admin' }), /role must be one of/);
  assert.throws(() => s.createUser({ name: 'B', email: 'b@example.com', group_id: 'grp_nope' }),
    err => err.code === 'NOT_FOUND');
});

test('updating a user keeps its id and rejects a clashing address', () => {
  const s = store();
  const a = s.createUser({ name: 'Alex', email: 'alex@example.com' });
  s.createUser({ name: 'Bo', email: 'bo@example.com' });
  const updated = s.updateUser(a.id, { role: 'approver' });
  assert.strictEqual(updated.id, a.id);
  assert.strictEqual(updated.role, 'approver');
  assert.strictEqual(updated.email, 'alex@example.com', 'an unmentioned field must survive the merge');
  assert.throws(() => s.updateUser(a.id, { email: 'bo@example.com' }), err => err.code === 'DUPLICATE');
});

/* ---------------- routing ---------------- */

test('recipients are the members of subscribed groups, de-duplicated and opt-out aware', () => {
  const s = store();
  const subscribed = s.createGroup({ name: 'Approvers', team: 'Platform', notify_events: ['approval.recorded'] });
  const quiet = s.createGroup({ name: 'Watchers', team: 'Platform', notify_events: [] });

  s.createUser({ name: 'Alex', email: 'alex@example.com', group_id: subscribed.id });
  s.createUser({ name: 'Bo', email: 'bo@example.com', group_id: subscribed.id, notify: false });
  s.createUser({ name: 'Cass', email: 'cass@example.com', group_id: quiet.id });
  s.createUser({ name: 'Dee', email: 'dee@example.com' });

  const to = s.recipients('approval.recorded').map(u => u.email);
  assert.deepStrictEqual(to, ['alex@example.com'],
    'opted-out, unsubscribed-group and group-less users must not be mailed');
  assert.deepStrictEqual(s.recipients('requirement.created'), []);
});
