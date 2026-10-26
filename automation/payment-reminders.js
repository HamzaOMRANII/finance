// C. Payment reminders, daily at 08:00 Africa/Lagos.
//  - sent invoices past their due date become 'overdue'
//  - due_date + 3 days and still unpaid: the OWNER is notified (once per invoice)
//  - due_date + 7 days: a polite reminder to the CLIENT, only for clients with
//    client_reminders enabled (off by default), once per invoice
const config = require('../src/server/config');
const db = require('../src/server/db');
const { runJob } = require('./lib/job');
const inv = require('../src/server/lib/invoices');
const mailer = require('../src/server/lib/mailer');
const templates = require('../src/server/lib/templates');
const { parseList } = require('../src/server/lib/bills');
const D = require('../src/shared/dates.mjs');
const { formatMoney } = require('../src/shared/money.mjs');

const OWNER_AFTER = 3;
const CLIENT_AFTER = 7;

runJob('payment-reminders', async ({ today, dryRun, log }) => {
  const overdue = inv.markOverdue({ today, dryRun });
  for (const o of overdue) log(`${dryRun ? '[dry-run] would mark' : 'marked'} ${o.invoice_number} overdue (due ${o.due_date})`);

  const open = db.all(`SELECT o.*, c.company_name, c.client_reminders, c.billing_emails, c.cc_emails
                       FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id
                       WHERE o.status IN ('sent','partially_paid','overdue') AND o.due_date IS NOT NULL ORDER BY o.due_date`);
  let owner = 0;
  let client = 0;
  for (const o of open) {
    const late = D.diffDays(o.due_date, today);
    const left = o.total - o.amount_received - inv.creditedTotal(o.id);
    if (left <= 0) continue;
    const amount = formatMoney(left, o.currency);

    if (late >= OWNER_AFTER) {
      const key = `reminder-owner:${o.id}`;
      if (dryRun) {
        if (!db.get('SELECT 1 FROM email_log WHERE dedupe_key = ?', key)) log(`[dry-run] would notify ${config.ownerEmail}: ${o.invoice_number} (${o.company_name}) ${amount} unpaid, ${late} days late`);
      } else {
        const out = await mailer.notifyOwner({
          kind: 'reminder-owner', dedupeKey: key,
          subject: `FinTrack · ${o.invoice_number} (${o.company_name}) unpaid, ${late} days late`,
          text: `${o.invoice_number} for ${o.company_name} was due on ${o.due_date}; ${amount} is still open.\n\nRecord the payment or follow up: ${templates.link(`/invoices/${o.id}`)}`,
        });
        if (!out.skipped) {
          owner++;
          inv.logEvent(o.id, 'reminder_owner', { to: config.ownerEmail, days_late: late }, 'automation');
          log(`owner notified about ${o.invoice_number} (${late} days late)`);
        }
      }
    }

    if (late >= CLIENT_AFTER && o.client_reminders) {
      const to = parseList(o.billing_emails);
      const key = `reminder-client:${o.id}`;
      if (!to.length) {
        log(`${o.invoice_number}: client reminders on but no billing email`);
      } else if (dryRun) {
        if (!db.get('SELECT 1 FROM email_log WHERE dedupe_key = ?', key)) log(`[dry-run] would send a polite reminder for ${o.invoice_number} to ${to.join(', ')}`);
      } else {
        const view = { ...inv.invoiceView(o), amount_received: o.amount_received };
        const mail = templates.clientReminderEmail(view, late);
        const out = await mailer.send({ kind: 'reminder-client', dedupeKey: key, to, cc: parseList(o.cc_emails), bcc: [config.ownerEmail], subject: mail.subject, text: mail.text });
        if (!out.skipped) {
          client++;
          inv.logEvent(o.id, 'reminder_client', { to, days_late: late }, 'automation');
          log(`client reminder sent for ${o.invoice_number} to ${to.join(', ')}`);
        }
      }
    }
  }
  return `${overdue.length} marked overdue, ${owner} owner notice(s), ${client} client reminder(s)`;
});
