// B. Outgoing invoice generator, daily at 08:00 Africa/Lagos.
//  1. Each active schedule whose next invoice is due gets its invoice for that period
//     (one per schedule+period, enforced by a UNIQUE key, so re-runs never duplicate):
//       approve_first (or any variable-quantity line): draft `lead` days before the send date,
//         then the owner is emailed a link + draft PDF;
//       auto_send: created approved on the send date, then sent in step 2.
//  2. Approved invoices whose send date has come are numbered, rendered and emailed to the
//     client's billing emails (+cc, BCC owner). One send per invoice (email_log dedupe key).
//  3. Invoices still awaiting approval on/after their send date are NOT sent: the owner is
//     reminded once per day instead.
const config = require('../src/server/config');
const db = require('../src/server/db');
const { runJob } = require('./lib/job');
const inv = require('../src/server/lib/invoices');
const mailer = require('../src/server/lib/mailer');
const { renderInvoice } = require('../src/server/lib/render');
const { link } = require('../src/server/lib/templates');
const { parseList } = require('../src/server/lib/bills');
const D = require('../src/shared/dates.mjs');
const { formatMoney } = require('../src/shared/money.mjs');

runJob('invoice-generator', async ({ today, dryRun, log }) => {
  let created = 0;
  let sent = 0;
  let waiting = 0;

  // ---- 1. schedules
  const schedules = db.all(`SELECT s.*, c.company_name FROM recurring_invoice_schedules s JOIN clients c ON c.id = s.client_id
                            WHERE s.active = 1 ORDER BY s.next_run_date`);
  for (const s0 of schedules) {
    let s = s0;
    // catch up if the job missed days; at most 3 periods per run
    for (let i = 0; i < 3; i++) {
      const needsReview = s.mode === 'approve_first' || parseList(s.line_items).some((it) => it.variable_quantity);
      const startOn = needsReview ? D.addDays(s.next_run_date, -s.approval_lead_days) : s.next_run_date;
      if (today < startOn) {
        log(`schedule #${s.id} ${s.company_name}: next ${needsReview ? 'draft' : 'invoice'} on ${startOn} (send ${s.next_run_date}), nothing to do`);
        break;
      }
      if (!parseList(s.line_items).length) {
        log(`schedule #${s.id} ${s.company_name}: has no line items, skipped (fix it on the Schedules page)`);
        break;
      }
      const { invoice, created: isNew } = inv.draftFromSchedule(s, s.next_run_date, { dryRun });
      const total = formatMoney(invoice.total, invoice.currency, invoice.language);
      if (!isNew) {
        log(`schedule #${s.id} ${s.company_name}: invoice for ${invoice.period_key} already exists (#${invoice.id}, ${invoice.status})`);
      } else {
        created++;
        log(`${dryRun ? '[dry-run] would create' : 'created'} ${invoice.status} invoice${invoice.id ? ` #${invoice.id}` : ''} for ${s.company_name}, period ${invoice.service_period_start}..${invoice.service_period_end}, send ${invoice.scheduled_send_date}, total ${total}`);
        for (const it of parseList(invoice.line_items)) log(`    ${it.quantity} × ${it.description} = ${formatMoney(it.amount, invoice.currency)}`);
        if (invoice.status === 'pending_approval' && dryRun) await askApproval(invoice, s, { dryRun, log });
        else if (dryRun) log(`[dry-run] auto_send: would then number it ${inv.peekNumber(s.issuer_profile_id, Number(today.slice(0, 4)))} and email it to the client`);
      }
      if (dryRun) break; // the schedule is not advanced in a dry run
      s = db.get('SELECT s.*, c.company_name FROM recurring_invoice_schedules s JOIN clients c ON c.id = s.client_id WHERE s.id = ?', s.id);
    }
  }

  // ---- 1b. approval requests not delivered yet (new drafts, or an earlier email failed)
  if (!dryRun) {
    const pending = db.all(`SELECT o.*, c.company_name FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id
                            LEFT JOIN email_log e ON e.dedupe_key = 'approval-request:' || o.id
                            WHERE o.status = 'pending_approval' AND o.scheduled_send_date > ? AND (e.id IS NULL OR e.status = 'failed')`, today);
    for (const o of pending) {
      try {
        await askApproval(o, o, { dryRun, log });
      } catch (err) {
        log(`!!! approval request for invoice #${o.id} not sent (retried next run): ${err.message}`);
      }
    }
  }

  // ---- 2. approved and due: send
  const due = db.all(`SELECT o.*, c.company_name, c.billing_emails FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id
                      WHERE o.status = 'approved' AND o.sent_at IS NULL AND COALESCE(o.scheduled_send_date, ?) <= ?`, today, today);
  for (const o of due) {
    if (!parseList(o.billing_emails).length) {
      log(`invoice #${o.id} ${o.company_name}: approved but the client has no billing email; owner notified`);
      if (!dryRun) {
        await notify(log, {
          kind: 'cannot-send', dedupeKey: `cannot-send:${o.id}:${today}`,
          subject: `FinTrack · cannot send ${o.company_name} invoice: no billing email`,
          text: `The approved invoice for ${o.company_name} (${formatMoney(o.total, o.currency)}) was due to be sent on ${o.scheduled_send_date}, but the client has no billing email.\n\nAdd one, or deliver the PDF yourself and use "Mark as sent": ${link(`/invoices/${o.id}`)}`,
        });
      }
      continue;
    }
    try {
      const out = await inv.send(o.id, { today, dryRun, actor: 'automation' });
      if (out.dryRun) log(`[dry-run] would number and email invoice #${o.id} as ${out.would.number} to ${out.would.to.join(', ')}${out.would.cc.length ? ` cc ${out.would.cc.join(', ')}` : ''} bcc ${out.would.bcc.join(', ')}: ${out.would.total}`);
      else if (out.skipped) log(`invoice #${o.id}: ${out.skipped}`);
      else {
        sent++;
        log(`sent ${out.invoice.invoice_number} to ${parseList(o.billing_emails).join(', ')}`);
      }
    } catch (err) {
      log(`!!! invoice #${o.id} not sent: ${err.message}`);
      if (!dryRun) {
        await notify(log, {
          kind: 'send-failed', dedupeKey: `send-failed:${o.id}:${today}`,
          subject: `FinTrack · sending the ${o.company_name} invoice failed`,
          text: `Error: ${err.message}\n\nRetry from ${link(`/invoices/${o.id}`)}`,
        });
      }
    }
  }

  // ---- 3. not approved in time: do not send, remind the owner
  const late = db.all(`SELECT o.*, c.company_name FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id
                       WHERE o.status IN ('draft','pending_approval') AND o.scheduled_send_date IS NOT NULL AND o.scheduled_send_date <= ?`, today);
  for (const o of late) {
    waiting++;
    log(`invoice #${o.id} ${o.company_name}: send date ${o.scheduled_send_date} reached without approval: NOT sent, owner reminded`);
    if (!dryRun) {
      const out = await notify(log, {
        kind: 'approval-overdue', dedupeKey: `approval-overdue:${o.id}:${today}`,
        subject: `FinTrack · ${o.company_name} invoice NOT sent: waiting for your approval`,
        text: `The invoice for ${o.company_name} (${formatMoney(o.total, o.currency)}) was planned for ${o.scheduled_send_date} and has not been sent because it is not approved.\n\nReview and approve it: ${link('/approvals')}`,
      });
      if (out.sent) inv.logEvent(o.id, 'reminder_owner', { reason: 'approval overdue' }, 'automation');
    }
  }

  return `${created} created, ${sent} sent, ${waiting} waiting for approval past their send date`;
});

// `schedule` only needs company_name here.
async function askApproval(invoice, schedule, { dryRun, log }) {
  const subject = `FinTrack · approve the ${schedule.company_name} invoice (send ${invoice.scheduled_send_date})`;
  const text = [
    `A draft invoice for ${schedule.company_name} is ready: ${formatMoney(invoice.total, invoice.currency, invoice.language)}, period ${invoice.service_period_start} to ${invoice.service_period_end}.`,
    `It will be emailed on ${invoice.scheduled_send_date} at 08:00 only if you approve it. Adjust the quantities first if needed.`,
    '',
    `Approve: ${link('/approvals')}`,
    '',
    'The draft PDF is attached. The number on it is the next free one; it is reserved only when the invoice is sent.',
  ].join('\n');
  if (dryRun) {
    log(`[dry-run] would email ${config.ownerEmail}: "${subject}" with the draft PDF`);
    return;
  }
  const { pdf } = await renderInvoice(inv.invoiceView(invoice));
  const out = await mailer.notifyOwner({
    kind: 'approval-request', dedupeKey: `approval-request:${invoice.id}`, subject, text,
    attachments: [{ filename: `draft-${schedule.company_name}-${invoice.period_key}.pdf`, content: pdf }],
  });
  if (!out.skipped) inv.logEvent(invoice.id, 'approval_requested', { to: config.ownerEmail }, 'automation');
  log(out.skipped ? `approval email skipped: ${out.skipped}` : `approval request emailed to ${config.ownerEmail}`);
}

// Owner notification that never aborts the run; failures are logged and retried next run
// (the email_log row stays 'failed', which the dedupe logic allows to be sent again).
async function notify(log, msg) {
  try {
    return await mailer.notifyOwner(msg);
  } catch (err) {
    log(`!!! could not email the owner (${msg.kind}): ${err.message}`);
    return {};
  }
}
