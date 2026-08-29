'use strict';

/**
 * Approval records — the shared decision store.
 *
 * The brief's requirement: "Actions write the same approval record the email
 * path writes, keyed by request id: if a decision already exists, show it rather
 * than allowing a conflicting second one."
 *
 * So this is deliberately NOT a plain append. `decide()` is idempotent on
 * request_id and refuses a second, different decision. Two channels — this UI
 * and an email reply — race on the same gate; whichever lands first wins, and
 * the loser is told what already happened rather than silently overwriting it.
 *
 * The append-only file is the audit trail; the conflict check reads it first.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_APPROVALS_PATH = process.env.AGENT_APPROVALS
  || path.join(__dirname, '..', '.agent', 'approvals.jsonl');

const DECISIONS = ['approved', 'bounced'];
const CHANNELS = ['ui', 'email'];

class ApprovalError extends Error {
  constructor(message, code, existing) {
    super(message);
    this.code = code;
    this.existing = existing;
  }
}

class FileApprovalStore {
  constructor(filePath = DEFAULT_APPROVALS_PATH) {
    this.filePath = filePath;
  }

  all() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip, same policy as the run log */ }
    }
    return out;
  }

  /** The decision of record for a request id, or null. First write wins. */
  find(request_id) {
    return this.all().find(a => a.request_id === request_id) || null;
  }

  /**
   * Record a decision.
   * - same request_id + same decision  -> returns the existing record (idempotent)
   * - same request_id + different one  -> throws CONFLICT with the existing record
   */
  decide({ request_id, ticket_key, gate, decision, reason, actor, channel = 'ui' }) {
    if (!request_id) throw new ApprovalError('request_id is required', 'BAD_REQUEST');
    if (!DECISIONS.includes(decision)) {
      throw new ApprovalError(`decision must be one of ${DECISIONS.join(', ')}`, 'BAD_REQUEST');
    }
    if (!CHANNELS.includes(channel)) {
      throw new ApprovalError(`channel must be one of ${CHANNELS.join(', ')}`, 'BAD_REQUEST');
    }
    // A bounce without a reason is useless to whoever has to act on it.
    if (decision === 'bounced' && !String(reason || '').trim()) {
      throw new ApprovalError('a bounce needs a reason', 'REASON_REQUIRED');
    }
    if (!String(actor || '').trim()) {
      throw new ApprovalError('actor is required — an approval with no name is not an audit record', 'BAD_REQUEST');
    }

    const existing = this.find(request_id);
    if (existing) {
      if (existing.decision === decision) return { record: existing, created: false };
      throw new ApprovalError(
        `this request was already ${existing.decision} by ${existing.actor} at ${existing.ts}`,
        'CONFLICT', existing,
      );
    }

    const record = {
      ts: new Date().toISOString(),
      request_id,
      ticket_key: ticket_key || null,
      gate: gate || null,
      decision,
      reason: String(reason || '').trim() || null,
      actor: String(actor).trim(),
      channel,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    return { record, created: true };
  }
}

module.exports = { FileApprovalStore, ApprovalError, DEFAULT_APPROVALS_PATH, DECISIONS };
