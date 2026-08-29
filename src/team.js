'use strict';

/**
 * Team & routing — the config the Mailer reads to decide WHO gets an approval
 * request for each gate. Changing a recipient is an edit here (driven from the
 * UI), never a code change.
 *
 * People belong to groups; each group owns at most one gate. When the agent
 * needs a gate approved, the Mailer calls resolveRecipients(gate) → the owning
 * group's distribution list, or its active members. A reply only counts if the
 * sender is one of those addresses (isMember).
 *
 * Same seam idea as the run log: file-backed today (.agent/team.json), a
 * PgTeamStore with the same methods later. The guards live here — the server and
 * the UI both call them, but this is the one that decides truth.
 */

const fs = require('fs');
const path = require('path');
const { GATE_ORDER } = require('./runLog');

const DEFAULT_TEAM_PATH = process.env.AGENT_TEAM
  || path.join(__dirname, '..', '.agent', 'team.json');

// Gates that route to a human group. Every gate except DoR, which the agent
// checks itself. Sourced from the run log's GATE_ORDER so the panel keeps ONE
// gate vocabulary rather than inventing a second.
const ROUTABLE_GATES = GATE_ORDER.filter(g => g !== 'DoR');
const GROUP_TYPES = ['dev', 'qa', 'tl', 'devops', 'ba', 'security'];
const APPROVAL_MODES = ['active-review', 'standing-delegation'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class TeamError extends Error {
  constructor(message, code = 'BAD_REQUEST', details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const newId = prefix => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const normEmail = e => String(e || '').trim().toLowerCase();

class FileTeamStore {
  constructor(filePath = DEFAULT_TEAM_PATH) {
    this.filePath = filePath;
  }

  _load() {
    let raw;
    try { raw = fs.readFileSync(this.filePath, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return { people: [], groups: [] }; throw err; }
    let j;
    try { j = JSON.parse(raw); } catch { throw new TeamError('team store is corrupt JSON', 'CORRUPT'); }
    return {
      people: Array.isArray(j.people) ? j.people : [],
      groups: Array.isArray(j.groups) ? j.groups : [],
    };
  }

  _save(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  /** The full config plus derived coverage — what the UI renders. */
  state() {
    const { people, groups } = this._load();
    const activeCount = g => g.members
      .map(id => people.find(p => p.id === id))
      .filter(p => p && p.active).length;

    const decorated = groups.map(g => ({ ...g, active_members: activeCount(g) }));
    const coverage = {};
    for (const gate of ROUTABLE_GATES) {
      const owner = decorated.find(g => g.owns_gate === gate);
      coverage[gate] = owner ? owner.id : null;
    }
    const unassigned = ROUTABLE_GATES.filter(gate => !coverage[gate]);
    // A group owns a gate but has no active member to mail — a real hole.
    const starved = decorated.filter(g => g.owns_gate && g.active_members === 0).map(g => g.owns_gate);

    return {
      people,
      groups: decorated,
      coverage,
      routable_gates: ROUTABLE_GATES,
      group_types: GROUP_TYPES,
      approval_modes: APPROVAL_MODES,
      unassigned_gates: unassigned,
      starved_gates: starved,
    };
  }

  // ---- people --------------------------------------------------------------

  addPerson({ name, email, jira_account, github_handle, active = true }) {
    const { people, groups } = this._load();
    this._validatePerson({ name, email }, people, null);
    const person = {
      id: newId('p'),
      name: String(name).trim(),
      email: normEmail(email),
      active: active !== false,
      jira_account: jira_account ? String(jira_account).trim() : null,
      github_handle: github_handle ? String(github_handle).trim() : null,
    };
    people.push(person);
    this._save({ people, groups });
    return person;
  }

  updatePerson(id, patch) {
    const { people, groups } = this._load();
    const p = people.find(x => x.id === id);
    if (!p) throw new TeamError('no such person', 'NOT_FOUND');
    if (patch.name !== undefined || patch.email !== undefined) {
      this._validatePerson({ name: patch.name ?? p.name, email: patch.email ?? p.email }, people, id);
    }
    if (patch.name !== undefined) p.name = String(patch.name).trim();
    if (patch.email !== undefined) p.email = normEmail(patch.email);
    if (patch.jira_account !== undefined) p.jira_account = patch.jira_account ? String(patch.jira_account).trim() : null;
    if (patch.github_handle !== undefined) p.github_handle = patch.github_handle ? String(patch.github_handle).trim() : null;
    if (patch.active !== undefined) p.active = Boolean(patch.active);
    this._save({ people, groups });
    return p;
  }

  _validatePerson({ name, email }, people, selfId) {
    if (!String(name || '').trim()) throw new TeamError('name is required');
    if (!EMAIL_RE.test(String(email || '').trim())) throw new TeamError('a valid email is required');
    const norm = normEmail(email);
    if (people.some(p => p.email === norm && p.id !== selfId)) {
      throw new TeamError('that email is already on the roster', 'DUPLICATE');
    }
  }

  // ---- groups --------------------------------------------------------------

  addGroup(input) {
    const { people, groups } = this._load();
    const group = this._buildGroup(input, null, people, groups);
    groups.push(group);
    this._save({ people, groups });
    return group;
  }

  updateGroup(id, input) {
    const { people, groups } = this._load();
    const idx = groups.findIndex(g => g.id === id);
    if (idx < 0) throw new TeamError('no such group', 'NOT_FOUND');
    const merged = { ...groups[idx], ...input, id };
    groups[idx] = this._buildGroup(merged, id, people, groups);
    this._save({ people, groups });
    return groups[idx];
  }

  _buildGroup(input, selfId, people, groups) {
    const name = String(input.name || '').trim();
    if (!name) throw new TeamError('group name is required');

    const type = input.type || 'dev';
    if (!GROUP_TYPES.includes(type)) throw new TeamError(`type must be one of ${GROUP_TYPES.join(', ')}`);

    const owns_gate = input.owns_gate ?? null;
    if (owns_gate !== null && !ROUTABLE_GATES.includes(owns_gate)) {
      throw new TeamError(`owns_gate must be one of ${ROUTABLE_GATES.join(', ')}`);
    }
    // Exactly one group per gate.
    if (owns_gate && groups.some(g => g.owns_gate === owns_gate && g.id !== selfId)) {
      throw new TeamError(`${owns_gate} is already owned by another group`, 'GATE_TAKEN', { gate: owns_gate });
    }

    const members = Array.isArray(input.members) ? [...new Set(input.members)] : [];
    for (const m of members) {
      if (!people.some(p => p.id === m)) throw new TeamError('a member is not on the roster');
    }

    // A gate that routes to nobody is worse than no gate. A group that OWNS a
    // gate must have at least one active member to receive the mail.
    if (owns_gate) {
      const active = members.map(id => people.find(p => p.id === id)).filter(p => p && p.active);
      const hasDL = Boolean(input.group_email && String(input.group_email).trim());
      if (active.length === 0 && !hasDL) {
        throw new TeamError(
          `a group owning ${owns_gate} needs at least one active member, or a distribution-list address`,
          'EMPTY_OWNER');
      }
    }

    let approval_mode = input.approval_mode || 'active-review';
    if (!APPROVAL_MODES.includes(approval_mode)) {
      throw new TeamError(`approval_mode must be one of ${APPROVAL_MODES.join(', ')}`);
    }
    // Security is always active review — never a standing delegation.
    const isSecurity = type === 'security' || owns_gate === 'RG-Sec';
    if (isSecurity) approval_mode = 'active-review';

    const group_email = input.group_email ? normEmail(input.group_email) : null;
    if (group_email && !EMAIL_RE.test(group_email)) throw new TeamError('group_email must be a valid email');

    const escalation_order = [];
    const rawEsc = Array.isArray(input.escalation_order) ? input.escalation_order : [];
    for (const e of rawEsc) {
      const pid = e && e.person_id;
      if (!members.includes(pid)) throw new TeamError('escalation order can only contain group members');
      const t = Number(e.timeout_hours);
      if (!Number.isFinite(t) || t <= 0) throw new TeamError('each escalation rung needs a positive timeout (hours)');
      escalation_order.push({ person_id: pid, timeout_hours: t });
    }

    return {
      id: selfId || newId('g'),
      name, type, owns_gate, group_email, members, approval_mode, escalation_order,
    };
  }

  // ---- the Mailer's questions ----------------------------------------------

  /** Who to mail for a gate. Empty recipients is stated, never faked. */
  resolveRecipients(gate) {
    const { people, groups } = this._load();
    const group = groups.find(g => g.owns_gate === gate);
    if (!group) return { gate, group: null, via: null, recipients: [], reason: 'no group owns this gate' };
    if (group.group_email) return { gate, group: group.name, via: 'distribution-list', recipients: [group.group_email] };
    const recipients = group.members
      .map(id => people.find(p => p.id === id))
      .filter(p => p && p.active)
      .map(p => p.email);
    return { gate, group: group.name, via: 'members', recipients };
  }

  /** Does an inbound reply address count as an approver for this gate? */
  isMember(gate, email) {
    const r = this.resolveRecipients(gate);
    return r.recipients.includes(normEmail(email));
  }
}

module.exports = {
  FileTeamStore, TeamError,
  ROUTABLE_GATES, GROUP_TYPES, APPROVAL_MODES, DEFAULT_TEAM_PATH,
};
