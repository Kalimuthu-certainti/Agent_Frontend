'use strict';

/**
 * Team & mail-routing store — who gets mailed for each gate.
 *
 * File-backed at .agent/team.json, Postgres behind the same seam later, exactly
 * like the settings store next door. The Mailer reads only this config, so
 * changing a recipient is a UI action, never a code change.
 *
 * The model, from TEAM-MODEL.md:
 *
 *   PERSON  id, name, email (unique), jira_account, github_handle, active
 *   GROUP   id, name, type (dev|qa|devops|ba|security), owns_gate (one gate,
 *           one owner), group_email (a DL that wins over per-member mail),
 *           member_ids, approval_mode, escalation_order
 *
 * Guards enforced here — the client guard is UX, this one is truth:
 *
 *  - email valid and unique across people
 *  - a gate has exactly one owning group; assigning it moves it (the UI asks
 *    for confirmation, the store just does the move atomically)
 *  - a group that owns a gate is never left without an active member by a
 *    GROUP write. Deactivating a PERSON is allowed — that is a fact about the
 *    world, not a config edit — and the payload flags the group empty instead.
 *  - a security group is always active review
 *  - escalation rungs reference members only, with positive timeouts
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GATE_ORDER } = require('./runLog');

const DEFAULT_TEAM_PATH = process.env.AGENT_TEAM
  || path.join(__dirname, '..', '.agent', 'team.json');

const GROUP_TYPES = ['dev', 'qa', 'devops', 'ba', 'security'];
const APPROVAL_MODES = ['active_review', 'standing_delegation'];
const DEFAULT_TIMEOUT_HOURS = 24;

const empty = () => ({ people: [], groups: [] });

class TeamError extends Error {
  constructor(message, code = 'BAD_REQUEST', extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const trim = v => String(v ?? '').trim();
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

class FileTeamStore {
  constructor(filePath = DEFAULT_TEAM_PATH) {
    this.filePath = filePath;
  }

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
      // A corrupt team file is not "no team" — say so rather than silently
      // resetting the routing to nobody.
      throw new TeamError(`team file is not valid JSON: ${this.filePath}`, 'CORRUPT');
    }
    return {
      people: Array.isArray(doc.people) ? doc.people : [],
      groups: Array.isArray(doc.groups) ? doc.groups : [],
    };
  }

  write(doc) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    return doc;
  }

  people() { return this.read().people; }
  groups() { return this.read().groups; }
  person(id) { return this.people().find(p => p.id === id) || null; }
  group(id) { return this.groups().find(g => g.id === id) || null; }

  /* ---------------- people ---------------- */

  createPerson(input = {}) {
    const doc = this.read();
    const person = {
      id: newId('per'),
      ...this.#personFields(input, doc, null),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    doc.people.push(person);
    this.write(doc);
    return person;
  }

  updatePerson(id, input = {}) {
    const doc = this.read();
    const i = doc.people.findIndex(p => p.id === id);
    if (i === -1) throw new TeamError(`no person ${id}`, 'NOT_FOUND');
    const merged = { ...doc.people[i], ...input };
    doc.people[i] = {
      ...doc.people[i],
      ...this.#personFields(merged, doc, id),
      updated_at: new Date().toISOString(),
    };
    this.write(doc);
    return doc.people[i];
  }

  #personFields(input, doc, selfId) {
    const name = trim(input.name);
    const email = trim(input.email).toLowerCase();
    if (!name) throw new TeamError('a person needs a name');
    if (!email) throw new TeamError('a person needs an email address');
    if (!isEmail(email)) throw new TeamError(`"${email}" is not a valid email address`);
    const clash = doc.people.find(p => p.id !== selfId && p.email === email);
    if (clash) throw new TeamError(`${email} already belongs to ${clash.name}`, 'DUPLICATE');
    return {
      name,
      email,
      jira_account: trim(input.jira_account) || null,
      github_handle: trim(input.github_handle) || null,
      // Deactivation is soft: the person stays in history and in member lists,
      // but is never mailed and never counts as an approver.
      active: input.active === undefined ? true : Boolean(input.active),
    };
  }

  /* ---------------- groups ---------------- */

  createGroup(input = {}) {
    const doc = this.read();
    const group = {
      id: newId('grp'),
      ...this.#groupFields(input, doc, null),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.#claimGate(doc, group.owns_gate, group.id);
    this.#requireActiveMemberIfOwning(group, doc);
    doc.groups.push(group);
    this.write(doc);
    return group;
  }

  updateGroup(id, input = {}) {
    const doc = this.read();
    const i = doc.groups.findIndex(g => g.id === id);
    if (i === -1) throw new TeamError(`no group ${id}`, 'NOT_FOUND');
    const merged = { ...doc.groups[i], ...input };
    const next = {
      ...doc.groups[i],
      ...this.#groupFields(merged, doc, id),
      updated_at: new Date().toISOString(),
    };
    this.#claimGate(doc, next.owns_gate, id);
    this.#requireActiveMemberIfOwning(next, doc);
    doc.groups[i] = next;
    this.write(doc);
    return next;
  }

  /** One gate, one owner: claiming a gate silently releases it from any other
   *  group in the same write, so the two can never disagree. The confirmation
   *  ("RG-Dev is owned by Developers — move it here?") is the UI's job. */
  #claimGate(doc, gate, ownerId) {
    if (!gate) return;
    for (const g of doc.groups) {
      if (g.id !== ownerId && g.owns_gate === gate) {
        g.owns_gate = null;
        g.updated_at = new Date().toISOString();
      }
    }
  }

  /** The hard guard: a config write may not leave a gate routed to nobody. */
  #requireActiveMemberIfOwning(group, doc) {
    if (!group.owns_gate) return;
    const active = group.member_ids
      .map(id => doc.people.find(p => p.id === id))
      .filter(p => p && p.active);
    if (active.length === 0) {
      throw new TeamError(
        `${group.name} owns ${group.owns_gate} but has no active members — ` +
        'approval requests for that gate would reach nobody. Add a member or release the gate.',
        'EMPTY_GROUP');
    }
  }

  #groupFields(input, doc, selfId) {
    const name = trim(input.name);
    const type = trim(input.type);
    if (!name) throw new TeamError('a group needs a name');
    if (!GROUP_TYPES.includes(type)) {
      throw new TeamError(`type must be one of ${GROUP_TYPES.join(', ')}`);
    }
    const clash = doc.groups.find(g => g.id !== selfId && g.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new TeamError(`a group called "${clash.name}" already exists`, 'DUPLICATE');

    const owns_gate = input.owns_gate ? trim(input.owns_gate) : null;
    if (owns_gate && !GATE_ORDER.includes(owns_gate)) {
      throw new TeamError(`unknown gate "${owns_gate}" — this build has ${GATE_ORDER.join(', ')}`);
    }

    const group_email = trim(input.group_email);
    if (group_email && !isEmail(group_email)) {
      throw new TeamError(`"${group_email}" is not a valid DL address`);
    }

    const rawMembers = Array.isArray(input.member_ids) ? input.member_ids : [];
    const member_ids = [...new Set(rawMembers.map(trim).filter(Boolean))];
    for (const id of member_ids) {
      if (!doc.people.some(p => p.id === id)) {
        throw new TeamError(`member ${id} is not in the roster`, 'UNKNOWN_MEMBER');
      }
    }

    const approval_mode = trim(input.approval_mode) || 'active_review';
    if (!APPROVAL_MODES.includes(approval_mode)) {
      throw new TeamError(`approval_mode must be one of ${APPROVAL_MODES.join(', ')}`);
    }
    // Security review is a judgement, not a rubber stamp — never delegable.
    if (type === 'security' && approval_mode !== 'active_review') {
      throw new TeamError('a security group is always active review — standing delegation is not offered',
        'SECURITY_LOCKED');
    }

    const rawEsc = Array.isArray(input.escalation_order) ? input.escalation_order : [];
    const seen = new Set();
    const escalation_order = rawEsc.map(r => {
      const person_id = trim(r && r.person_id);
      const timeout_hours = r && r.timeout_hours === undefined
        ? DEFAULT_TIMEOUT_HOURS : Number(r.timeout_hours);
      if (!member_ids.includes(person_id)) {
        throw new TeamError(`escalation rung ${person_id || '(empty)'} is not a member of ${name}`,
          'BAD_ESCALATION');
      }
      if (seen.has(person_id)) {
        throw new TeamError(`escalation lists ${person_id} twice`, 'BAD_ESCALATION');
      }
      seen.add(person_id);
      if (!Number.isFinite(timeout_hours) || timeout_hours <= 0) {
        throw new TeamError('every escalation timeout must be a positive number of hours', 'BAD_ESCALATION');
      }
      return { person_id, timeout_hours };
    });

    return {
      name, type, owns_gate,
      group_email: group_email || null,
      member_ids, approval_mode, escalation_order,
    };
  }

  /* ---------------- routing ---------------- */

  /** {gate: group_id | null} for every gate, in pipeline order. A null is a
   *  gate whose approval requests would reach nobody — the UI's red chip. */
  coverage(groups = this.groups()) {
    const out = {};
    for (const gate of GATE_ORDER) {
      const owner = groups.find(g => g.owns_gate === gate);
      out[gate] = owner ? owner.id : null;
    }
    return out;
  }

  /**
   * Who gets mailed for `gate` — what the Mailer calls. Resolution:
   * gate → owning group → the DL if one is set, else each active member.
   * Returns null when no group owns the gate; `emails` may still be empty
   * when the owning group has no active members (both are reported, never
   * silently dropped).
   */
  recipients(gate) {
    const doc = this.read();
    const group = doc.groups.find(g => g.owns_gate === gate);
    if (!group) return null;
    if (group.group_email) {
      return { group_id: group.id, group_name: group.name, via: 'dl', emails: [group.group_email] };
    }
    const emails = group.member_ids
      .map(id => doc.people.find(p => p.id === id))
      .filter(p => p && p.active)
      .map(p => p.email);
    return { group_id: group.id, group_name: group.name, via: 'members', emails };
  }

  /** Is this sender allowed to decide for `gate`? Used by the email reply path
   *  to surface "reply from unknown sender — ignored" instead of a silent drop. */
  knownSender(gate, email) {
    const doc = this.read();
    const group = doc.groups.find(g => g.owns_gate === gate);
    if (!group) return false;
    const addr = trim(email).toLowerCase();
    if (group.group_email && group.group_email.toLowerCase() === addr) return true;
    return group.member_ids
      .map(id => doc.people.find(p => p.id === id))
      .some(p => p && p.active && p.email === addr);
  }

  /** The GET /api/team payload. The vocabulary comes from the server so the UI
   *  cannot offer a gate, a type or a mode that this build does not honour. */
  payload() {
    const doc = this.read();
    return {
      people: doc.people,
      groups: doc.groups,
      coverage: this.coverage(doc.groups),
      gate_order: GATE_ORDER,
      group_types: GROUP_TYPES,
      approval_modes: APPROVAL_MODES,
      team_path: this.filePath,
    };
  }
}

module.exports = {
  FileTeamStore, TeamError,
  DEFAULT_TEAM_PATH, GROUP_TYPES, APPROVAL_MODES, DEFAULT_TIMEOUT_HOURS,
};
