'use strict';

/**
 * Event → configuration group → mail.
 *
 * The one rule here: a notification failure must never fail the action that
 * triggered it. An approval that was recorded is recorded, whether or not the
 * SMTP server was reachable a moment later. So `notify()` resolves with an
 * outcome — sent / skipped / failed — and never throws into the request path.
 * The outcome is returned to the caller and printed, not swallowed.
 */

const { sendMail, MailError } = require('./mailer');

/** Bodies live here rather than at the call sites, so the wording stays in one place. */
const TEMPLATES = {
  'approval.recorded': ({ record, base_url }) => ({
    subject: `[${record.ticket_key || 'agent'}] ${record.gate || 'gate'} ${record.decision} by ${record.actor}`,
    text: [
      `${record.actor} ${record.decision} ${record.gate || 'a gate'}` +
        `${record.ticket_key ? ` on ${record.ticket_key}` : ''}.`,
      '',
      `Ticket:    ${record.ticket_key || 'not recorded'}`,
      `Gate:      ${record.gate || 'not recorded'}`,
      `Decision:  ${record.decision}`,
      `Reason:    ${record.reason || '— none given —'}`,
      `Recorded:  ${record.ts}`,
      `Channel:   ${record.channel}`,
      '',
      base_url ? `Open the panel: ${base_url}` : 'Open the Agent Control panel to see the queue.',
      '',
      'You are on this list because your configuration group subscribes to approval.recorded.',
    ].join('\n'),
  }),

  'requirement.created': ({ issue, summary, actor, base_url }) => ({
    subject: `[${issue.key}] new requirement — ${summary}`,
    text: [
      `${actor || 'Someone'} created a requirement in Jira.`,
      '',
      `Key:       ${issue.key}`,
      `Summary:   ${summary}`,
      '',
      base_url ? `Open the panel: ${base_url}` : 'Open the Agent Control panel for the queue.',
      '',
      'You are on this list because your configuration group subscribes to requirement.created.',
    ].join('\n'),
  }),
};

/**
 * Send the mail for one event.
 *
 * Resolves with:
 *   { status: 'sent',    event, recipients: [...], message_id }
 *   { status: 'skipped', event, reason }            — no mail config, or nobody subscribed
 *   { status: 'failed',  event, recipients, error } — the server refused or was unreachable
 */
async function notify(store, event, context = {}) {
  const template = TEMPLATES[event];
  if (!template) return { status: 'skipped', event, reason: `no template for ${event}` };

  let recipients;
  let cfg;
  try {
    if (!store.configured()) {
      return { status: 'skipped', event, reason: 'mail is not configured on this server' };
    }
    recipients = store.recipients(event);
    cfg = store.mail();
  } catch (err) {
    // A corrupt settings file should not take the approval down with it.
    return { status: 'failed', event, recipients: [], error: String(err && err.message || err) };
  }

  if (!recipients.length) {
    return { status: 'skipped', event, reason: `no configuration group subscribes to ${event}` };
  }

  const { subject, text } = template(context);
  const to = recipients.map(r => r.email);
  try {
    const res = await sendMail(cfg, { to, subject, text });
    return {
      status: 'sent', event,
      recipients: res.accepted,
      refused: res.refused.map(r => r.address),
      message_id: res.message_id,
    };
  } catch (err) {
    return {
      status: 'failed', event, recipients: to,
      error: String(err && err.message || err),
      code: err instanceof MailError ? err.code : 'MAIL_ERROR',
    };
  }
}

/** One line on stdout per notification, so a silent skip is still visible in the log. */
function logOutcome(outcome) {
  if (!outcome) return;
  const detail = outcome.status === 'sent' ? `→ ${outcome.recipients.join(', ')}`
    : outcome.status === 'skipped' ? outcome.reason
    : outcome.error;
  process.stdout.write(`notify  ${outcome.event}  ${outcome.status}  ${detail}\n`);
}

module.exports = { notify, logOutcome, TEMPLATES };
