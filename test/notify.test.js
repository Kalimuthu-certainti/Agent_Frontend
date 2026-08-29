'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const { FileSettingsStore } = require('../src/settings');
const { notify } = require('../src/notify');

const store = () => new FileSettingsStore(
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-not-')), 'settings.json'));

/** The smallest SMTP server that accepts everything, so we can assert on the body. */
function acceptAll() {
  const received = [];
  const server = net.createServer(socket => {
    let buf = '', inData = false, body = '';
    socket.write('220 fake.test ESMTP\r\n');
    socket.on('data', c => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; received.push(body); socket.write('250 Ok: queued\r\n'); }
          else body += line + '\n';
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write('250-fake.test\r\n250 HELP\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
        else socket.write('250 Ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1',
    () => r({ port: server.address().port, received, close: () => new Promise(x => server.close(x)) })));
}

const withMail = (s, port) => s.saveMail({
  host: '127.0.0.1', port, security: 'none', from_email: 'bot@example.com', from_name: 'Agent Control',
});

const RECORD = {
  ts: '2026-08-29T09:00:00.000Z', request_id: 'APP-142:G4', ticket_key: 'APP-142',
  gate: 'G4', decision: 'approved', reason: null, actor: 'alex', channel: 'ui',
};

test('with no mail configured it skips, and says why', async () => {
  const s = store();
  s.createGroup({ name: 'Approvers', team: 'Platform', roles: ['approver'],
    notify_events: ['approval.recorded'] });
  const out = await notify(s, 'approval.recorded', { record: RECORD });
  assert.strictEqual(out.status, 'skipped');
  assert.match(out.reason, /not configured/);
});

test('with mail configured but nobody subscribed it skips rather than mailing nobody', async () => {
  const smtp = await acceptAll();
  try {
    const s = store();
    withMail(s, smtp.port);
    s.createUser({ name: 'Alex', email: 'alex@example.com', role: 'viewer' }); // role claimed by nobody
    const out = await notify(s, 'approval.recorded', { record: RECORD });
    assert.strictEqual(out.status, 'skipped');
    assert.match(out.reason, /no configuration group subscribes/);
    assert.strictEqual(smtp.received.length, 0);
  } finally { await smtp.close(); }
});

test('mails the subscribed group, with the decision in the body', async () => {
  const smtp = await acceptAll();
  try {
    const s = store();
    withMail(s, smtp.port);
    s.createGroup({ name: 'Approvers', team: 'Platform', roles: ['approver'],
      notify_events: ['approval.recorded'] });
    s.createUser({ name: 'Alex', email: 'alex@example.com', role: 'approver' });

    const out = await notify(s, 'approval.recorded', { record: RECORD, base_url: 'http://panel.test' });
    assert.strictEqual(out.status, 'sent');
    assert.deepStrictEqual(out.recipients, ['alex@example.com']);

    const body = smtp.received[0];
    assert.match(body, /Subject: \[APP-142\] G4 approved by alex/);
    assert.match(body, /Decision: {2}approved/);
    assert.match(body, /Reason: {4}— none given —/);
    assert.match(body, /http:\/\/panel\.test/);
  } finally { await smtp.close(); }
});

test('an unreachable mail server is reported, never thrown into the caller', async () => {
  const s = store();
  s.saveMail({ host: '127.0.0.1', port: 1, security: 'none', from_email: 'bot@example.com' });
  s.createGroup({ name: 'Approvers', team: 'Platform', roles: ['approver'],
    notify_events: ['approval.recorded'] });
  s.createUser({ name: 'Alex', email: 'alex@example.com', role: 'approver' });

  const out = await notify(s, 'approval.recorded', { record: RECORD });
  assert.strictEqual(out.status, 'failed', 'the approval itself must still stand');
  assert.match(out.error, /127\.0\.0\.1:1/);
});

test('an event with no template is skipped, not guessed at', async () => {
  const out = await notify(store(), 'nothing.like.this', {});
  assert.strictEqual(out.status, 'skipped');
});
