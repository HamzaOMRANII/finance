// Outgoing email. Two rules are enforced here, for every caller:
//  1. Recipients must be the owner or an address stored on a client (billing or cc emails).
//  2. Each message has a dedupe key; the email_log row is claimed before sending, so running a
//     job twice (or two jobs at once) never sends the same email twice.
const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');
const { HttpError } = require('./validate');
const { parseList } = require('./bills');

let transport;
function getTransport() {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
    throw new HttpError(503, 'SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS in .env)');
  }
  transport ||= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transport;
}

function allowedRecipients() {
  const set = new Set();
  if (config.ownerEmail) set.add(config.ownerEmail.toLowerCase());
  for (const c of db.all('SELECT billing_emails, cc_emails FROM clients')) {
    for (const e of [...parseList(c.billing_emails), ...parseList(c.cc_emails)]) set.add(String(e).toLowerCase());
  }
  return set;
}

function assertAllowed(addresses) {
  const allowed = allowedRecipients();
  const bad = addresses.filter((a) => !allowed.has(String(a).toLowerCase()));
  if (bad.length) throw new HttpError(403, `refusing to email ${bad.join(', ')}: not the owner and not stored on any client`);
}

// Returns { sent: true, messageId } or { skipped: reason }.
async function send({ kind, dedupeKey, to = [], cc = [], bcc = [], subject, text, html, attachments }) {
  to = [].concat(to).filter(Boolean);
  cc = [].concat(cc).filter(Boolean);
  bcc = [].concat(bcc).filter(Boolean);
  if (!to.length) throw new HttpError(400, 'no recipient');
  assertAllowed([...to, ...cc, ...bcc]);

  // Claim the key. A 'failed' row may be retried; 'pending'/'sent' rows mean someone else has it.
  const claimed = db.tx(() => {
    const row = db.get('SELECT id, status FROM email_log WHERE dedupe_key = ?', dedupeKey);
    if (row && row.status !== 'failed') return null;
    const recipients = JSON.stringify({ to, cc, bcc });
    if (row) {
      db.run("UPDATE email_log SET status = 'pending', error = NULL, recipients = ?, subject = ? WHERE id = ?", recipients, subject, row.id);
      return row.id;
    }
    return db.insert('email_log', { dedupe_key: dedupeKey, kind, recipients, subject, status: 'pending' });
  });
  if (!claimed) return { skipped: `already sent (${dedupeKey})` };

  try {
    const info = await getTransport().sendMail({
      from: config.smtp.from, to, cc, bcc, subject, text, html, attachments,
    });
    db.run("UPDATE email_log SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?", info.messageId || null, new Date().toISOString(), claimed);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    db.run("UPDATE email_log SET status = 'failed', error = ? WHERE id = ?", String(err.message).slice(0, 500), claimed);
    throw err;
  }
}

// Notification to the owner only.
function notifyOwner({ kind, dedupeKey, subject, text, attachments }) {
  if (!config.ownerEmail) throw new HttpError(503, 'OWNER_EMAIL is not configured');
  return send({ kind, dedupeKey, to: [config.ownerEmail], subject, text, attachments });
}

module.exports = { send, notifyOwner, assertAllowed, allowedRecipients };
