// The AGENT calls this, in its own flow, when it decides to notify a gate.
// It sends the mail itself, in-process, via Microsoft Graph — no GitHub token,
// no repository_dispatch, no workflow, no CI round-trip. Nothing auto-triggers:
// the agent chooses the moment (e.g. after committing the solution doc, or
// after opening the PR).
//
// Credentials are resolved by send-mail.mjs at run time (environment, then the
// macOS Keychain, then ~/.config/agent/graph.env) and are never logged.
// Recipients come from team.md — this can only mail an address in that file.
//
// Usage:
//   node scripts/notify-gate.mjs RG-Dev "Review: TRDV2-600" "<p>Please review the solution doc.</p>"
//   node scripts/notify-gate.mjs G4     "Merge permission: TRDV2-600" "<p>PR is green. OK to merge?</p>"
//   node scripts/notify-gate.mjs RG-Dev "Review: TRDV2-600" body.html      # body read from a file
//   node scripts/notify-gate.mjs --dry-run RG-Dev "subject" "<p>body</p>"  # resolve, print, don't send
//
// Exits 0 on a delivered send, non-zero on any failure, so the agent can gate on it.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const [gate, subject, body] = argv.filter(a => a !== '--dry-run');

if (!gate) {
  console.error('usage: notify-gate.mjs [--dry-run] <GATE> <subject> <html|path-to-html-file>');
  process.exit(1);
}

// A body that names an existing file is read from it — solution-doc mails are
// too long to sit on a command line.
const html = body && existsSync(body) ? readFileSync(body, 'utf8') : (body || '');

const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(process.execPath, [join(here, 'send-mail.mjs'), ...(dryRun ? ['--dry-run'] : [])], {
  cwd: join(here, '..'),
  stdio: 'inherit',
  env: { ...process.env, GATE: gate, SUBJECT: subject || '', HTML: html },
});

if (res.status === 0) {
  console.log(dryRun ? `\n(dry run) ${gate} would be notified.` : `\nnotified ${gate}.`);
}
process.exit(res.status ?? 1);
