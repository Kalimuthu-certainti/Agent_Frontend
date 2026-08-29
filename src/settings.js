'use strict';

/**
 * Configuration store — mail settings, configuration groups, and the user registry.
 *
 * File-backed today, Postgres behind the same seam later, exactly like the
 * approval store next door. The difference is that approvals are append-only
 * (an audit trail) while configuration is a mutable document, so this is a
 * read-modify-write of one JSON file rather than a JSONL append.
 *
 * Two rules carried over from the rest of the panel:
 *
 *  - Absent is absent. Mail that was never configured reads as `null`, not as
 *    an object full of empty strings that looks half-set-up.
 *  - The SMTP password never leaves the server. `redacted()` is what the API
 *    returns; the raw value is readable only by the mailer.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS_PATH = process.env.AGENT_SETTINGS
  || path.join(__dirname, '..', '.agent', 'settings.json');

/** How the connection is secured. Named, because "secure: true" tells you nothing. */
const SECURITY = ['tls', 'starttls', 'none'];

const ROLES = ['owner', 'approver', 'viewer'];

/**
 * Events a group can be notified about. This list is exactly what the server
 * actually emits — nothing is offered here that would silently never fire.
 */
const EVENTS = ['approval.recorded', 'requirement.created'];

/** A fresh document every time — a shared literal would let one store's
 *  push() mutate the "empty" state every other store starts from. */
const empty = () => ({ mail: null, groups: [], users: [] });

class SettingsError extends Error {
  constructor(message, code = 'BAD_REQUEST', extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const trim = v => String(v ?? '').trim();
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

class FileSettingsStore {
  constructor(filePath = DEFAULT_SETTINGS_PATH) {
    this.filePath = filePath;
  }

  /** The whole document, including the SMTP password. Server-side only. */
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return empty();
      throw err;
    }
    let doc;
    try { doc = JSON.parse(raw); } catch {
      // A corrupt settings file is not "no settings" — say so rather than
      // silently resetting somebody's configuration to empty.
      throw new SettingsError(`settings file is not valid JSON: ${this.filePath}`, 'CORRUPT');
    }
    return {
      mail: doc.mail ?? null,
      groups: Array.isArray(doc.groups) ? doc.groups : [],
      users: Array.isArray(doc.users) ? doc.users : [],
    };
  }

  write(doc) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Written via a temp file so a crash mid-write cannot truncate the config.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    return doc;
  }

  /* ---------------- mail ---------------- */

  /** Raw mail config, password included. For the mailer, never for a response. */
  mail() {
    return this.read().mail;
  }

  /** What the API is allowed to return: everything except the password itself. */
  redactedMail() {
    const m = this.mail();
    if (!m) return null;
    const { password, ...rest } = m;
    return { ...rest, password_set: Boolean(password) };
  }

  configured() {
    const m = this.mail();
    if (!m) return false;
    if (!m.host || !m.port || !m.from_email) return false;
    // A username with no password is a half-configured server that will fail
    // at AUTH; report it as not configured rather than letting it 535.
    if (m.username && !m.password) return false;
    return true;
  }

  /**
   * Save mail settings. Omitting `password` keeps the stored one — the UI never
   * receives it, so it cannot send it back, and a blind round-trip must not
   * wipe it. Send `password: ''` to explicitly clear it.
   */
  saveMail(patch = {}) {
    const doc = this.read();
    const prev = doc.mail || {};

    const host = trim(patch.host);
    const port = Number(patch.port);
    const security = trim(patch.security) || 'starttls';
    const from_email = trim(patch.from_email);

    if (!host) throw new SettingsError('SMTP host is required');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SettingsError('SMTP port must be a whole number between 1 and 65535');
    }
    if (!SECURITY.includes(security)) {
      throw new SettingsError(`security must be one of ${SECURITY.join(', ')}`);
    }
    if (!from_email) throw new SettingsError('a from address is required');
    if (!isEmail(from_email)) throw new SettingsError(`"${from_email}" is not a valid email address`);
    const reply_to = trim(patch.reply_to);
    if (reply_to && !isEmail(reply_to)) {
      throw new SettingsError(`"${reply_to}" is not a valid reply-to address`);
    }

    const username = trim(patch.username);
    const password = patch.password === undefined
      ? (prev.password ?? null)
      : (String(patch.password) || null);
    if (username && !password) {
      throw new SettingsError('a username needs a password — set both or neither', 'PASSWORD_REQUIRED');
    }

    doc.mail = {
      host,
      port,
      security,
      username: username || null,
      password,
      from_name: trim(patch.from_name) || null,
      from_email,
      reply_to: reply_to || null,
      updated_at: new Date().toISOString(),
    };
    this.write(doc);
    return this.redactedMail();
  }

  /* ---------------- groups ---------------- */

  groups() {
    return this.read().groups;
  }

  group(id) {
    return this.groups().find(g => g.id === id) || null;
  }

  /** Members of a group, in registry order. */
  members(group_id) {
    return this.read().users.filter(u => u.group_id === group_id);
  }

  createGroup(input = {}) {
    const doc = this.read();
    const group = {
      id: newId('grp'),
      ...this.#groupFields(input, doc.groups, null),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    doc.groups.push(group);
    this.write(doc);
    return group;
  }

  updateGroup(id, input = {}) {
    const doc = this.read();
    const i = doc.groups.findIndex(g => g.id === id);
    if (i === -1) throw new SettingsError(`no group ${id}`, 'NOT_FOUND');
    const merged = { ...doc.groups[i], ...input };
    doc.groups[i] = {
      ...doc.groups[i],
      ...this.#groupFields(merged, doc.groups, id),
      updated_at: new Date().toISOString(),
    };
    this.write(doc);
    return doc.groups[i];
  }

  /**
   * Refuses while the group still has members. Deleting it silently would
   * detach people from their notifications without anyone being told.
   */
  deleteGroup(id) {
    const doc = this.read();
    const i = doc.groups.findIndex(g => g.id === id);
    if (i === -1) throw new SettingsError(`no group ${id}`, 'NOT_FOUND');
    const members = doc.users.filter(u => u.group_id === id);
    if (members.length) {
      throw new SettingsError(
        `${members.length} user${members.length === 1 ? ' is' : 's are'} still in this group ` +
        `(${members.map(u => u.email).join(', ')}) — move or remove them first`,
        'GROUP_NOT_EMPTY', { members: members.map(u => u.email) });
    }
    const [gone] = doc.groups.splice(i, 1);
    this.write(doc);
    return gone;
  }

  #groupFields(input, groups, selfId) {
    const name = trim(input.name);
    const team = trim(input.team);
    if (!name) throw new SettingsError('a group needs a name');
    if (!team) throw new SettingsError('a group needs a team');
    const clash = groups.find(g => g.id !== selfId && g.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new SettingsError(`a group called "${clash.name}" already exists`, 'DUPLICATE');

    const raw = Array.isArray(input.notify_events) ? input.notify_events : [];
    const unknown = raw.filter(e => !EVENTS.includes(e));
    if (unknown.length) {
      throw new SettingsError(
        `unknown event${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} — ` +
        `this server emits ${EVENTS.join(', ')}`, 'UNKNOWN_EVENT');
    }
    return {
      name,
      team,
      description: trim(input.description) || null,
      notify_events: [...new Set(raw)],
    };
  }

  /* ---------------- users ---------------- */

  users() {
    return this.read().users;
  }

  user(id) {
    return this.users().find(u => u.id === id) || null;
  }

  createUser(input = {}) {
    const doc = this.read();
    const user = {
      id: newId('usr'),
      ...this.#userFields(input, doc, null),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    doc.users.push(user);
    this.write(doc);
    return user;
  }

  updateUser(id, input = {}) {
    const doc = this.read();
    const i = doc.users.findIndex(u => u.id === id);
    if (i === -1) throw new SettingsError(`no user ${id}`, 'NOT_FOUND');
    const merged = { ...doc.users[i], ...input };
    doc.users[i] = {
      ...doc.users[i],
      ...this.#userFields(merged, doc, id),
      updated_at: new Date().toISOString(),
    };
    this.write(doc);
    return doc.users[i];
  }

  deleteUser(id) {
    const doc = this.read();
    const i = doc.users.findIndex(u => u.id === id);
    if (i === -1) throw new SettingsError(`no user ${id}`, 'NOT_FOUND');
    const [gone] = doc.users.splice(i, 1);
    this.write(doc);
    return gone;
  }

  #userFields(input, doc, selfId) {
    const name = trim(input.name);
    const email = trim(input.email).toLowerCase();
    const role = trim(input.role) || 'viewer';
    if (!name) throw new SettingsError('a user needs a name');
    if (!email) throw new SettingsError('a user needs an email address');
    if (!isEmail(email)) throw new SettingsError(`"${email}" is not a valid email address`);
    if (!ROLES.includes(role)) throw new SettingsError(`role must be one of ${ROLES.join(', ')}`);

    const clash = doc.users.find(u => u.id !== selfId && u.email === email);
    if (clash) throw new SettingsError(`${email} is already in the registry`, 'DUPLICATE');

    const group_id = trim(input.group_id) || null;
    if (group_id && !doc.groups.some(g => g.id === group_id)) {
      throw new SettingsError(`no group ${group_id}`, 'NOT_FOUND');
    }
    return {
      name,
      email,
      role,
      group_id,
      notify: input.notify === undefined ? true : Boolean(input.notify),
    };
  }

  /* ---------------- notification routing ---------------- */

  /**
   * Who should be emailed about `event`: members of every group subscribed to
   * it who have not opted out. De-duplicated by address, because one person in
   * two subscribed groups is still one email.
   */
  recipients(event) {
    const doc = this.read();
    const subscribed = new Set(
      doc.groups.filter(g => (g.notify_events || []).includes(event)).map(g => g.id));
    const seen = new Set();
    const out = [];
    for (const u of doc.users) {
      if (!u.notify || !u.group_id || !subscribed.has(u.group_id)) continue;
      if (seen.has(u.email)) continue;
      seen.add(u.email);
      out.push(u);
    }
    return out;
  }
}

module.exports = {
  FileSettingsStore, SettingsError,
  DEFAULT_SETTINGS_PATH, SECURITY, ROLES, EVENTS,
};
