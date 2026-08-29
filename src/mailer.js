'use strict';

/**
 * A small SMTP client, Node built-ins only.
 *
 * The rest of this project has no dependencies and this one feature is not a
 * good enough reason to acquire a tree of them. What is here is the submission
 * path an outbound relay actually needs — EHLO, optional STARTTLS, AUTH
 * PLAIN/LOGIN, MAIL FROM / RCPT TO / DATA — and nothing else. It is not a mail
 * server, does not queue, and does not retry: one connection, one message, an
 * honest result either way.
 *
 * When it fails it reports the server's own reply text. "Could not send mail"
 * with the 535 swallowed is the anti-pattern.
 */

const net = require('net');
const tls = require('tls');

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 15000;

class MailError extends Error {
  constructor(message, code = 'MAIL_ERROR', extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/**
 * Wraps a socket in a promise-shaped "send a command, await the reply" API.
 * SMTP replies can be multi-line ("250-PIPELINING" … "250 HELP"); a reply is
 * complete only on a line whose 4th character is a space.
 */
class SmtpConnection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.pending = null;
    this.closed = null;
    this.transcript = [];

    socket.setEncoding('utf8');
    socket.on('data', chunk => this.#onData(chunk));
    socket.on('error', err => this.#fail(new MailError(err.message, 'CONNECTION_ERROR')));
    socket.on('close', () => this.#fail(new MailError('the server closed the connection', 'CONNECTION_CLOSED')));
  }

  #onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf(CRLF)) !== -1) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      this.lines = this.lines || [];
      this.lines.push(line);
      if (line[3] === ' ' || line.length <= 3) {
        const lines = this.lines;
        this.lines = null;
        this.#resolve({ code: Number(lines[0].slice(0, 3)), lines, text: lines.join('\n') });
      }
    }
  }

  #resolve(reply) {
    this.transcript.push(`S: ${reply.text}`);
    const p = this.pending;
    this.pending = null;
    if (p) { clearTimeout(p.timer); p.resolve(reply); }
  }

  #fail(err) {
    this.closed = this.closed || err;
    const p = this.pending;
    this.pending = null;
    if (p) { clearTimeout(p.timer); p.reject(err); }
  }

  /** Await one reply from the server. */
  reply() {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(new MailError(`the server did not reply within ${this.timeoutMs}ms`, 'TIMEOUT')),
        this.timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  /** Send a command and await its reply. `redact` keeps secrets out of the transcript. */
  async send(command, { redact = false } = {}) {
    if (this.closed) throw this.closed;
    this.transcript.push(`C: ${redact ? '***' : command}`);
    this.socket.write(command + CRLF);
    return this.reply();
  }

  /** Send a command and require a reply in the expected class. `command: null` just awaits one. */
  async expect(command, codes, what, opts) {
    const reply = command === null ? await this.reply() : await this.send(command, opts);
    if (!codes.includes(reply.code)) {
      throw new MailError(`${what} failed — the server said: ${reply.text}`, 'SMTP_REJECTED',
        { smtp_code: reply.code, smtp_reply: reply.text });
    }
    return reply;
  }

  end() {
    this.closed = this.closed || new MailError('connection ended', 'CONNECTION_CLOSED');
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('error');
    this.socket.on('error', () => { /* teardown races are not interesting */ });
    this.socket.end();
    this.socket.destroy();
  }
}

function connect(cfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port, servername: cfg.host };
    const socket = cfg.security === 'tls'
      ? tls.connect({ ...opts, rejectUnauthorized: cfg.reject_unauthorized !== false })
      : net.connect(opts);
    const event = cfg.security === 'tls' ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new MailError(
        `could not reach ${cfg.host}:${cfg.port} within ${timeoutMs}ms`, 'CONNECT_TIMEOUT'));
    }, timeoutMs);
    socket.once(event, () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', err => {
      clearTimeout(timer);
      reject(new MailError(`could not reach ${cfg.host}:${cfg.port} — ${err.message}`, 'CONNECT_FAILED'));
    });
  });
}

function upgrade(socket, cfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket, servername: cfg.host, rejectUnauthorized: cfg.reject_unauthorized !== false,
    });
    const timer = setTimeout(
      () => reject(new MailError(`the TLS handshake did not complete within ${timeoutMs}ms`, 'TIMEOUT')),
      timeoutMs);
    secure.once('secureConnect', () => { clearTimeout(timer); resolve(secure); });
    secure.once('error', err => {
      clearTimeout(timer);
      reject(new MailError(`STARTTLS failed — ${err.message}`, 'TLS_FAILED'));
    });
  });
}

const addressList = to => (Array.isArray(to) ? to : [to]).map(a => String(a).trim()).filter(Boolean);

const headerSafe = v => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

/** RFC 5322 display-name + address, with the name quoted only when it needs to be. */
function formatFrom(cfg) {
  const name = headerSafe(cfg.from_name);
  if (!name) return cfg.from_email;
  return `"${name.replace(/["\\]/g, '\\$&')}" <${cfg.from_email}>`;
}

function buildMessage(cfg, message) {
  const to = addressList(message.to);
  const date = new Date().toUTCString();
  const id = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@agent-control>`;
  const headers = [
    `From: ${formatFrom(cfg)}`,
    `To: ${to.map(headerSafe).join(', ')}`,
    `Subject: ${headerSafe(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (cfg.reply_to) headers.push(`Reply-To: ${headerSafe(cfg.reply_to)}`);
  // Dot-stuffing: a line that is a lone "." would otherwise end the DATA block.
  const body = String(message.text ?? '')
    .replace(/\r?\n/g, CRLF)
    .replace(/^\./gm, '..');
  return { data: headers.join(CRLF) + CRLF + CRLF + body, to, message_id: id };
}

function supports(greeting, keyword) {
  return greeting.lines.some(l => l.slice(4).toUpperCase().startsWith(keyword));
}

/**
 * Send one message. Resolves with the accepted recipients; rejects with a
 * MailError carrying the server's reply when the server refuses.
 */
async function sendMail(cfg, message, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!cfg || !cfg.host || !cfg.port || !cfg.from_email) {
    throw new MailError('mail is not configured on this server', 'NOT_CONFIGURED');
  }
  const built = buildMessage(cfg, message);
  if (!built.to.length) throw new MailError('a message needs at least one recipient', 'NO_RECIPIENTS');

  let socket = await connect(cfg, timeoutMs);
  let conn = new SmtpConnection(socket, timeoutMs);
  const ehloName = cfg.ehlo_name || 'agent-control';

  try {
    await conn.expect(null, [220], 'the SMTP greeting');
    let greeting = await conn.expect(`EHLO ${ehloName}`, [250], 'EHLO');

    if (cfg.security === 'starttls') {
      if (!supports(greeting, 'STARTTLS')) {
        throw new MailError(
          `${cfg.host}:${cfg.port} does not offer STARTTLS — use direct TLS (usually port 465) ` +
          'or, for a local relay, no encryption', 'STARTTLS_UNSUPPORTED');
      }
      await conn.expect('STARTTLS', [220], 'STARTTLS');
      const secure = await upgrade(socket, cfg, timeoutMs);
      const transcript = conn.transcript;
      conn.socket.removeAllListeners('data');
      conn.socket.removeAllListeners('close');
      conn.socket.removeAllListeners('error');
      socket = secure;
      conn = new SmtpConnection(secure, timeoutMs);
      conn.transcript = transcript;
      // The capability list is re-issued on the encrypted channel; the one from
      // before the upgrade cannot be trusted.
      greeting = await conn.expect(`EHLO ${ehloName}`, [250], 'EHLO after STARTTLS');
    }

    if (cfg.username) {
      const mechanisms = (greeting.lines.find(l => l.slice(4).toUpperCase().startsWith('AUTH')) || '')
        .slice(4).toUpperCase();
      if (mechanisms.includes('PLAIN')) {
        const token = Buffer.from(`\0${cfg.username}\0${cfg.password}`).toString('base64');
        await conn.expect(`AUTH PLAIN ${token}`, [235], 'authentication', { redact: true });
      } else if (mechanisms.includes('LOGIN') || !mechanisms) {
        await conn.expect('AUTH LOGIN', [334], 'authentication');
        await conn.expect(Buffer.from(cfg.username).toString('base64'), [334], 'the username', { redact: true });
        await conn.expect(Buffer.from(cfg.password).toString('base64'), [235], 'the password', { redact: true });
      } else {
        throw new MailError(
          `the server offers no supported auth mechanism (it advertises: ${mechanisms || 'none'}); ` +
          'this client speaks PLAIN and LOGIN', 'AUTH_UNSUPPORTED');
      }
    }

    await conn.expect(`MAIL FROM:<${cfg.from_email}>`, [250], 'MAIL FROM');
    const accepted = [];
    const refused = [];
    for (const rcpt of built.to) {
      const reply = await conn.send(`RCPT TO:<${rcpt}>`);
      if ([250, 251].includes(reply.code)) accepted.push(rcpt);
      else refused.push({ address: rcpt, reply: reply.text });
    }
    if (!accepted.length) {
      throw new MailError(
        `every recipient was refused — ${refused.map(r => `${r.address}: ${r.reply}`).join('; ')}`,
        'ALL_RECIPIENTS_REFUSED', { refused });
    }

    await conn.expect('DATA', [354], 'DATA');
    conn.transcript.push(`C: <${Buffer.byteLength(built.data)} bytes of message>`);
    conn.socket.write(built.data + CRLF + '.' + CRLF);
    const queued = await conn.expect(null, [250], 'the message body');

    try { await conn.send('QUIT'); } catch { /* a missing QUIT reply does not un-send the mail */ }

    return {
      accepted, refused,
      message_id: built.message_id,
      server_reply: queued.text,
      transcript: conn.transcript,
    };
  } catch (err) {
    if (err instanceof MailError) { err.transcript = conn.transcript; throw err; }
    throw new MailError(String(err && err.message || err), 'MAIL_ERROR', { transcript: conn.transcript });
  } finally {
    conn.end();
  }
}

module.exports = { sendMail, buildMessage, MailError, DEFAULT_TIMEOUT_MS };
