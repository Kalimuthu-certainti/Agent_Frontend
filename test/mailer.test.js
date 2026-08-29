'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { sendMail, buildMessage, MailError } = require('../src/mailer');

/**
 * A fake SMTP server. It records every command it is given and answers from a
 * table, so these tests exercise the real socket path — greeting, EHLO, AUTH,
 * envelope, DATA — rather than a mock of it.
 *
 * `replies` overrides the default answer for a command prefix.
 */
function fakeSmtp({ replies = {}, capabilities = ['AUTH PLAIN LOGIN'] } = {}) {
  const seen = [];
  const server = net.createServer(socket => {
    let buf = '';
    let inData = false;
    let body = '';
    socket.write('220 fake.test ESMTP ready\r\n');

    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            seen.push({ command: 'BODY', body });
            socket.write('250 2.0.0 Ok: queued as ABC123\r\n');
          } else {
            body += line + '\n';
          }
          continue;
        }

        seen.push({ command: line });
        const key = Object.keys(replies).find(
          k => line.startsWith(k) || line.toUpperCase().startsWith(k.toUpperCase()));
        if (key) { socket.write(replies[key]); continue; }

        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          socket.write(['250-fake.test', ...capabilities.map(c => `250-${c}`), '250 HELP']
            .map(l => l + '\r\n').join(''));
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    socket.on('error', () => { /* the client hangs up first on some paths */ });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

const cfg = (port, extra = {}) => ({
  host: '127.0.0.1', port, security: 'none',
  from_name: 'Agent Control', from_email: 'bot@example.com',
  username: null, password: null, ...extra,
});

const commands = seen => seen.map(s => s.command);

test('walks the full submission path and reports the queue reply', async () => {
  const smtp = await fakeSmtp();
  try {
    const res = await sendMail(cfg(smtp.port), {
      to: 'alex@example.com', subject: 'Hello', text: 'A body.',
    });
    assert.deepStrictEqual(res.accepted, ['alex@example.com']);
    assert.match(res.server_reply, /queued as ABC123/);

    const c = commands(smtp.seen);
    assert.ok(c[0].startsWith('EHLO'), `first command was ${c[0]}`);
    assert.ok(c.includes('MAIL FROM:<bot@example.com>'));
    assert.ok(c.includes('RCPT TO:<alex@example.com>'));
    assert.ok(c.includes('DATA'));
    assert.ok(c.includes('QUIT'));
  } finally { await smtp.close(); }
});

test('sends the headers a mail client needs, with the display name quoted', async () => {
  const smtp = await fakeSmtp();
  try {
    await sendMail(cfg(smtp.port, { reply_to: 'ops@example.com' }), {
      to: ['alex@example.com', 'bo@example.com'], subject: 'Gate G4 approved', text: 'body',
    });
    const { body } = smtp.seen.find(s => s.command === 'BODY');
    assert.match(body, /^From: "Agent Control" <bot@example\.com>$/m);
    assert.match(body, /^To: alex@example\.com, bo@example\.com$/m);
    assert.match(body, /^Subject: Gate G4 approved$/m);
    assert.match(body, /^Reply-To: ops@example\.com$/m);
    assert.match(body, /^Content-Type: text\/plain; charset=utf-8$/m);
  } finally { await smtp.close(); }
});

test('authenticates with PLAIN when the server advertises it', async () => {
  const smtp = await fakeSmtp({ replies: { 'AUTH PLAIN': '235 2.7.0 Authentication successful\r\n' } });
  try {
    await sendMail(cfg(smtp.port, { username: 'bot', password: 'pw' }),
      { to: 'alex@example.com', subject: 's', text: 't' });
    const auth = commands(smtp.seen).find(c => c.startsWith('AUTH PLAIN'));
    assert.ok(auth, 'expected an AUTH PLAIN command');
    assert.strictEqual(
      Buffer.from(auth.slice('AUTH PLAIN '.length), 'base64').toString('utf8'), '\0bot\0pw');
  } finally { await smtp.close(); }
});

test('falls back to LOGIN when PLAIN is not offered', async () => {
  const smtp = await fakeSmtp({
    capabilities: ['AUTH LOGIN'],
    // Ym90 is base64 "bot", cHc= is base64 "pw" — the two AUTH LOGIN turns.
    replies: { 'AUTH LOGIN': '334 VXNlcm5hbWU6\r\n', 'Ym90': '334 UGFzc3dvcmQ6\r\n', 'cHc=': '235 Ok\r\n' },
  });
  try {
    await sendMail(cfg(smtp.port, { username: 'bot', password: 'pw' }),
      { to: 'alex@example.com', subject: 's', text: 't' });
    assert.ok(commands(smtp.seen).includes('AUTH LOGIN'));
  } finally { await smtp.close(); }
});

test('a rejected password surfaces the server reply, not a generic failure', async () => {
  const smtp = await fakeSmtp({ replies: { 'AUTH PLAIN': '535 5.7.8 Authentication credentials invalid\r\n' } });
  try {
    await assert.rejects(
      sendMail(cfg(smtp.port, { username: 'bot', password: 'wrong' }),
        { to: 'alex@example.com', subject: 's', text: 't' }),
      err => err instanceof MailError && err.code === 'SMTP_REJECTED'
        && /535 5\.7\.8 Authentication credentials invalid/.test(err.message));
  } finally { await smtp.close(); }
});

test('a refused recipient is reported with the address that was refused', async () => {
  const smtp = await fakeSmtp({ replies: { 'RCPT TO': '550 5.1.1 No such user\r\n' } });
  try {
    await assert.rejects(
      sendMail(cfg(smtp.port), { to: 'ghost@example.com', subject: 's', text: 't' }),
      err => err.code === 'ALL_RECIPIENTS_REFUSED' && /ghost@example\.com/.test(err.message));
  } finally { await smtp.close(); }
});

test('partial delivery still sends, and names who was refused', async () => {
  const smtp = await fakeSmtp({ replies: { 'RCPT TO:<bo@': '550 5.1.1 No such user\r\n' } });
  try {
    const res = await sendMail(cfg(smtp.port), {
      to: ['alex@example.com', 'bo@example.com'], subject: 's', text: 't',
    });
    assert.deepStrictEqual(res.accepted, ['alex@example.com']);
    assert.deepStrictEqual(res.refused.map(r => r.address), ['bo@example.com']);
  } finally { await smtp.close(); }
});

test('STARTTLS that the server does not offer is refused with advice, not a hang', async () => {
  const smtp = await fakeSmtp({ capabilities: [] });
  try {
    await assert.rejects(
      sendMail(cfg(smtp.port, { security: 'starttls' }), { to: 'a@example.com', subject: 's', text: 't' }),
      err => err.code === 'STARTTLS_UNSUPPORTED' && /port 465/.test(err.message));
  } finally { await smtp.close(); }
});

test('an unreachable server fails fast with the address it tried', async () => {
  // Port 1 is reserved and never listening.
  await assert.rejects(
    sendMail(cfg(1), { to: 'a@example.com', subject: 's', text: 't' }, { timeoutMs: 2000 }),
    err => ['CONNECT_FAILED', 'CONNECT_TIMEOUT'].includes(err.code) && /127\.0\.0\.1:1/.test(err.message));
});

test('an unconfigured server refuses before opening a socket', async () => {
  await assert.rejects(
    sendMail(null, { to: 'a@example.com', subject: 's', text: 't' }),
    err => err.code === 'NOT_CONFIGURED');
});

/* ---- message construction, without a server ---- */

test('a lone dot in the body is stuffed so it cannot end the DATA block early', () => {
  const built = buildMessage({ from_email: 'b@example.com' }, { to: 'a@example.com', text: 'one\n.\ntwo' });
  assert.match(built.data, /\r\n\.\.\r\n/);
});

test('a newline injected into a subject cannot forge a header', () => {
  const built = buildMessage({ from_email: 'b@example.com' },
    { to: 'a@example.com', subject: 'ok\r\nBcc: attacker@example.com', text: '' });
  assert.doesNotMatch(built.data, /^Bcc:/m);
  assert.match(built.data, /^Subject: ok Bcc: attacker@example\.com$/m);
});
