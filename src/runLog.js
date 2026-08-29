'use strict';

/**
 * Run-log writer — one JSON line per agent step, appended to .agent/run-log.jsonl
 *
 * Contract (the data contract from the brief):
 *   ts, run_id, claude_session_id, model, agent_name, ticket_key, phase, step,
 *   tokens_in, tokens_out, cost_usd, context_pct, gate, verdict
 *
 * Two invariants this file exists to hold:
 *
 *  1. A field that was not measured is written as `null` — never defaulted to 0.
 *     A zero is a measurement. A null is an absence. Everything downstream, up
 *     to and including the pixels, depends on being able to tell them apart.
 *
 *  2. A malformed record throws rather than being written. A corrupt log is
 *     worse than a missing one, because it looks like data.
 *
 * Synchronous append: a step must never be lost because the logger was mid-flush
 * when the process died.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_PATH = process.env.AGENT_RUN_LOG
  || path.join(__dirname, '..', '.agent', 'run-log.jsonl');

/** Gates in pipeline order — the gate strip renders in exactly this sequence. */
const GATE_ORDER = ['DoR', 'RG-TL', 'RG-Dev', 'RG-Test', 'RG-Ver', 'RG-Sec', 'G4'];

const VERDICTS = ['pass', 'approved', 'bounced', 'blocked', 'pending', 'escalated'];

/** Verdicts that mean a gate is genuinely cleared. Nothing else counts. */
const CLEARING_VERDICTS = ['pass', 'approved'];

const NULLABLE = [
  'claude_session_id', 'model', 'ticket_key', 'phase', 'step',
  'tokens_in', 'tokens_out', 'cost_usd', 'context_pct',
  'gate', 'verdict', 'note', 'pr_url', 'ci_state', 'solution_commit',
];

class RunLogError extends Error {}

function buildRecord(input) {
  if (!input || typeof input !== 'object') {
    throw new RunLogError('step record must be an object');
  }
  for (const required of ['run_id', 'agent_name']) {
    if (!input[required] || typeof input[required] !== 'string') {
      throw new RunLogError(`step record needs a non-empty string "${required}"`);
    }
  }
  if (input.gate != null && !GATE_ORDER.includes(input.gate)) {
    throw new RunLogError(`unknown gate "${input.gate}" — expected one of ${GATE_ORDER.join(', ')}`);
  }
  if (input.verdict != null && !VERDICTS.includes(input.verdict)) {
    throw new RunLogError(`unknown verdict "${input.verdict}" — expected one of ${VERDICTS.join(', ')}`);
  }
  if (input.context_pct != null) {
    const n = Number(input.context_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new RunLogError('context_pct must be a number between 0 and 100');
    }
  }
  for (const key of ['tokens_in', 'tokens_out', 'cost_usd']) {
    if (input[key] != null && !Number.isFinite(Number(input[key]))) {
      throw new RunLogError(`${key} must be a number when present`);
    }
  }

  const record = {
    ts: input.ts || new Date().toISOString(),
    run_id: input.run_id,
    agent_name: input.agent_name,
  };
  for (const key of NULLABLE) {
    record[key] = input[key] === undefined ? null : input[key];
  }
  // Rows reconstructed after the fact are real events but were not measured
  // live. The UI badges them so nobody reads them as telemetry.
  record.source = input.source === 'backfill' ? 'backfill' : 'live';
  return record;
}

function appendStep(input, logPath = DEFAULT_LOG_PATH) {
  const record = buildRecord(input);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

module.exports = {
  appendStep, buildRecord, RunLogError,
  GATE_ORDER, VERDICTS, CLEARING_VERDICTS, DEFAULT_LOG_PATH,
};
