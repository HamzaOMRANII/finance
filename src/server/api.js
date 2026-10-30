// JSON API. Every route except login/session/healthz needs a session; every non-GET route
// also needs the CSRF header (enforced in server.js from route.opts).
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { Router, sendJson, HttpError } = require('./http');
const bills = require('./lib/bills');
const inv = require('./lib/invoices');
const receipts = require('./lib/receipts');
const dashboard = require('./lib/dashboard');
const files = require('./lib/files');
const { renderInvoicePdf } = require('./lib/pdf');
const { renderInvoice, usesTemplate } = require('./lib/render');
const D = require('../shared/dates.mjs');
const { toEurMinor, fromMinor } = require('../shared/money.mjs');

const r = new Router();
const pub = { public: true };
const id = (p) => {
  const n = Number(p.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad id');
  return n;
};
const parseJsonCols = (row, cols) => {
  if (!row) return row;
  const out = { ...row };
  for (const c of cols) if (typeof out[c] === 'string') out[c] = JSON.parse(out[c] || 'null');
  return out;
};
const INVOICE_JSON = ['line_items', 'tax_lines', 'issuer_snapshot', 'client_snapshot', 'sent_to'];
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sendBuffer = (res, buffer, name, type, download) => {
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': buffer.length, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
  });
  res.end(buffer);
};
const sendPdf = (res, buffer, name, download = false) => sendBuffer(res, buffer, name, 'application/pdf', download);

// ------------------------------------------------------------------ session
r.post('/api/login', ({ req, res, body }) => auth.login(req, res, body), pub);
r.post('/api/logout', ({ req, res }) => { auth.logout(req, res); return { ok: true }; }, pub);
r.get('/api/session', ({ req }) => {
  const s = auth.session(req);
  if (!s) throw new HttpError(401, 'login required');
  return {
    username: s.user.username,
    csrf: s.csrf,
    meta: {
      owner_email: config.ownerEmail,
      smtp_configured: !!(config.smtp.host && config.smtp.user && config.smtp.pass),
      receipts_ai: config.anthropic.enabled && !!config.anthropic.apiKey,
      today: D.today(),
    },
  };
}, pub);

// ------------------------------------------------------------------ dashboard
r.get('/api/dashboard', () => dashboard.summary());
r.get('/api/calendar', ({ query }) => {
  const month = /^\d{4}-\d{2}$/.test(query.get('month') || '') ? query.get('month') : D.today().slice(0, 7);
  return { month, events: dashboard.calendar(month) };
});

// ------------------------------------------------------------------ cards
const cardOut = (c) => parseJsonCols(c, ['usable_countries']);
r.get('/api/cards', () => db.all(`SELECT c.*, (SELECT COUNT(*) FROM bills b WHERE b.payment_card_id = c.id AND b.status != 'cancelled') AS bill_count
                                  FROM cards c ORDER BY c.status = 'active' DESC, c.label`).map(cardOut));
r.get('/api/cards/:id', ({ params }) => {
  const card = cardOut(bills.mustGet('cards', id(params)));
  card.bills = bills.billsWithCards('b.payment_card_id = ?', card.id).map((b) => ({ ...b, warnings: bills.billWarnings(b) }));
  return card;
});
r.post('/api/cards', ({ body }) => ({ id: db.insert('cards', bills.cleanCard(body)) }));
r.put('/api/cards/:id', ({ params, body }) => {
  bills.mustGet('cards', id(params));
  db.update('cards', id(params), bills.cleanCard(body, { partial: true }));
  return { ok: true };
});
r.del('/api/cards/:id', ({ params }) => {
  bills.mustGet('cards', id(params));
  db.run('DELETE FROM cards WHERE id = ?', id(params));
  return { ok: true };
});

// ------------------------------------------------------------------ bills
r.get('/api/bills', ({ query }) => {
  const where = ['1=1'];
  const p = [];
  if (query.get('status')) { where.push('b.status = ?'); p.push(query.get('status')); }
  if (query.get('card')) { where.push('b.payment_card_id = ?'); p.push(Number(query.get('card'))); }
  if (query.get('currency')) { where.push('b.currency = ?'); p.push(query.get('currency')); }
  if (query.get('from')) { where.push('b.due_date >= ?'); p.push(query.get('from')); }
  if (query.get('to')) { where.push('b.due_date <= ?'); p.push(query.get('to')); }
  if (query.get('q')) {
    where.push('(b.vendor LIKE ? OR b.title LIKE ? OR b.receiver_name LIKE ? OR b.category LIKE ?)');
    const q = `%${query.get('q')}%`;
    p.push(q, q, q, q);
  }
  const today = D.today();
  const rates = dashboard.fxRates();
  return bills.billsWithCards(where.join(' AND '), ...p).map((b) => {
    const due = bills.amountDue(b);
    return {
      ...b, amount_due: due.amount, amount_estimated: due.estimated, amount_due_eur: toEurMinor(due.amount, b.currency, rates),
      days_left: D.diffDays(today, b.due_date), warnings: bills.billWarnings(b, today),
    };
  });
});
r.get('/api/bills/:id', ({ params }) => {
  const [bill] = bills.billsWithCards('b.id = ?', id(params));
  if (!bill) throw new HttpError(404, 'bill not found');
  bill.warnings = bills.billWarnings(bill);
  bill.payments = db.all('SELECT * FROM payments_log WHERE bill_id = ? ORDER BY paid_date DESC', bill.id);
  return bill;
});
// No amount typed but a receipt picked: read the amount from that old invoice.
async function amountFromReceipt(body, currency) {
  if (!body || (body.amount !== undefined && body.amount !== null && body.amount !== '') || !body.receipt_file) return body;
  const found = await receipts.extract(String(body.receipt_file)).catch(() => null);
  const f = found?.fields || {};
  if (f.amount === null || f.amount === undefined || f.currency !== (body.currency || currency)) return body;
  return { ...body, amount: fromMinor(f.amount, f.currency) };
}
r.post('/api/bills', async ({ body }) => ({ id: bills.createBill(await amountFromReceipt(body)) }));
r.put('/api/bills/:id', async ({ params, body }) => {
  const existing = bills.mustGet('bills', id(params));
  bills.updateBill(id(params), await amountFromReceipt(body, existing.currency));
  return { ok: true };
});
r.del('/api/bills/:id', ({ params }) => {
  bills.mustGet('bills', id(params));
  db.run('DELETE FROM bills WHERE id = ?', id(params));
  return { ok: true };
});
r.post('/api/bills/:id/pay', ({ params, body }) => ({ payment_id: bills.markPaid(id(params), body) }));
r.get('/api/payments', () => db.all(`SELECT p.*, b.vendor, b.title FROM payments_log p JOIN bills b ON b.id = p.bill_id ORDER BY p.paid_date DESC LIMIT 200`));

// ------------------------------------------------------------------ receipts
r.get('/api/receipts', () => receipts.list());
r.get('/api/receipts/file', ({ res, query }) => {
  files.serveFile(res, files.resolveInside(config.receiptsDir, query.get('path')), { download: query.get('download') === '1' });
});
r.post('/api/receipts/extract', ({ body }) => receipts.extract(String(body.path || ''), { useAi: !!body.ai }));

// ------------------------------------------------------------------ issuer profiles
r.get('/api/issuers', () => db.all('SELECT * FROM issuer_profiles ORDER BY is_default DESC, legal_name'));
r.get('/api/issuers/:id', ({ params }) => bills.mustGet('issuer_profiles', id(params)));
r.post('/api/issuers', ({ body }) => ({ id: inv.saveIssuer(null, body) }));
r.put('/api/issuers/:id', ({ params, body }) => ({ id: inv.saveIssuer(id(params), body) }));
r.del('/api/issuers/:id', ({ params }) => {
  const used = db.get(`SELECT (SELECT COUNT(*) FROM outgoing_invoices WHERE issuer_profile_id = ?) + (SELECT COUNT(*) FROM recurring_invoice_schedules WHERE issuer_profile_id = ?) AS n`, id(params), id(params)).n;
  if (used) throw new HttpError(409, 'this profile is used by invoices or schedules');
  db.run('DELETE FROM invoice_counters WHERE issuer_profile_id = ? AND last_number = 0', id(params));
  db.run('DELETE FROM issuer_profiles WHERE id = ?', id(params));
  return { ok: true };
});

// ------------------------------------------------------------------ clients
const clientOut = (c) => parseJsonCols(c, ['billing_emails', 'cc_emails']);
r.get('/api/clients', () => db.all(`SELECT c.*,
    (SELECT COUNT(*) FROM outgoing_invoices o WHERE o.client_id = c.id AND o.invoice_number IS NOT NULL) AS invoice_count,
    (SELECT COALESCE(SUM(o.total - o.amount_received), 0) FROM outgoing_invoices o WHERE o.client_id = c.id AND o.status IN ('sent','partially_paid','overdue')) AS outstanding
  FROM clients c ORDER BY c.company_name`).map(clientOut));
r.get('/api/clients/:id', ({ params }) => {
  const c = clientOut(bills.mustGet('clients', id(params)));
  c.invoices = db.all('SELECT * FROM outgoing_invoices WHERE client_id = ? ORDER BY COALESCE(issue_date, scheduled_send_date) DESC, id DESC', c.id)
    .map((o) => parseJsonCols(o, ['line_items', 'tax_lines']));
  c.credit_notes = db.all(`SELECT cn.*, o.invoice_number FROM credit_notes cn JOIN outgoing_invoices o ON o.id = cn.invoice_id
                           WHERE o.client_id = ? ORDER BY cn.issue_date DESC`, c.id);
  c.schedules = db.all('SELECT * FROM recurring_invoice_schedules WHERE client_id = ?', c.id).map((s) => parseJsonCols(s, ['line_items', 'tax_lines']));
  return c;
});
r.post('/api/clients', ({ body }) => ({ id: inv.saveClient(null, body) }));
r.put('/api/clients/:id', ({ params, body }) => ({ id: inv.saveClient(id(params), body) }));
r.del('/api/clients/:id', ({ params }) => {
  const used = db.get('SELECT (SELECT COUNT(*) FROM outgoing_invoices WHERE client_id = ?) + (SELECT COUNT(*) FROM recurring_invoice_schedules WHERE client_id = ?) AS n', id(params), id(params)).n;
  if (used) throw new HttpError(409, 'client has invoices or schedules; it cannot be deleted');
  db.run('DELETE FROM clients WHERE id = ?', id(params));
  return { ok: true };
});

// ------------------------------------------------------------------ schedules
const schedOut = (s) => {
  const out = parseJsonCols(s, ['line_items', 'tax_lines']);
  out.draft_date = s.mode === 'approve_first' ? D.addDays(s.next_run_date, -s.approval_lead_days) : null;
  out.period = inv.periodFor(s, s.next_run_date);
  out.total = inv.computeTotals(out.line_items, out.tax_lines).total;
  return out;
};
r.get('/api/schedules', () => db.all(`SELECT s.*, c.company_name, i.legal_name AS issuer_name, i.prefix
  FROM recurring_invoice_schedules s JOIN clients c ON c.id = s.client_id JOIN issuer_profiles i ON i.id = s.issuer_profile_id
  ORDER BY s.active DESC, s.next_run_date`).map(schedOut));
r.get('/api/schedules/:id', ({ params }) => schedOut(bills.mustGet('recurring_invoice_schedules', id(params))));
r.post('/api/schedules', ({ body }) => ({ id: inv.saveSchedule(null, body) }));
r.put('/api/schedules/:id', ({ params, body }) => ({ id: inv.saveSchedule(id(params), body) }));
r.del('/api/schedules/:id', ({ params }) => {
  bills.mustGet('recurring_invoice_schedules', id(params));
  if (db.get('SELECT 1 FROM outgoing_invoices WHERE schedule_id = ?', id(params))) {
    db.update('recurring_invoice_schedules', id(params), { active: 0 });
    return { ok: true, deactivated: true };
  }
  db.run('DELETE FROM recurring_invoice_schedules WHERE id = ?', id(params));
  return { ok: true };
});
// What the next run will produce (no writes).
r.get('/api/schedules/:id/preview.pdf', async ({ res, params }) => {
  const s = bills.mustGet('recurring_invoice_schedules', id(params));
  const { invoice } = inv.draftFromSchedule(s, s.next_run_date, { dryRun: true });
  sendPdf(res, (await renderInvoice(inv.invoiceView(invoice))).pdf, `schedule-${s.id}-preview.pdf`);
});

// ------------------------------------------------------------------ invoices
r.get('/api/invoices', ({ query }) => {
  const where = ['1=1'];
  const p = [];
  if (query.get('status')) { where.push('o.status = ?'); p.push(query.get('status')); }
  if (query.get('client')) { where.push('o.client_id = ?'); p.push(Number(query.get('client'))); }
  if (query.get('issuer')) { where.push('o.issuer_profile_id = ?'); p.push(Number(query.get('issuer'))); }
  return db.all(`SELECT o.*, c.company_name, i.prefix, i.legal_name AS issuer_name FROM outgoing_invoices o
    JOIN clients c ON c.id = o.client_id JOIN issuer_profiles i ON i.id = o.issuer_profile_id
    WHERE ${where.join(' AND ')} ORDER BY COALESCE(o.issue_date, o.scheduled_send_date, o.created_at) DESC, o.id DESC`, ...p)
    .map((o) => {
      const out = parseJsonCols(o, ['line_items', 'tax_lines', 'sent_to']);
      if (!out.invoice_number && out.status !== 'void') out.next_number = inv.draftNumber(out);
      return out;
    });
});
r.get('/api/approvals', () => db.all(`SELECT o.*, c.company_name, c.billing_emails FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id
  WHERE o.status IN ('pending_approval','approved') AND o.sent_at IS NULL ORDER BY o.scheduled_send_date`)
  .map((o) => parseJsonCols(o, ['line_items', 'tax_lines', 'billing_emails'])));
r.get('/api/invoices/:id', ({ params }) => {
  const o = parseJsonCols(bills.mustGet('outgoing_invoices', id(params)), INVOICE_JSON);
  o.client = clientOut(bills.mustGet('clients', o.client_id));
  o.events = db.all('SELECT * FROM invoice_events WHERE invoice_id = ? ORDER BY created_at, id', o.id).map((e) => parseJsonCols(e, ['detail']));
  o.payments = db.all('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_date', o.id);
  o.credit_notes = db.all('SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY issue_date', o.id).map((c) => parseJsonCols(c, ['line_items', 'tax_lines']));
  o.credited = inv.creditedTotal(o.id);
  o.next_number = o.invoice_number ? null : inv.draftNumber(o);
  o.auto_number = o.invoice_number ? null : inv.peekNumber(o.issuer_profile_id, D.today());
  o.has_docx = !o.is_legacy && usesTemplate({ kind: 'invoice', language: o.language });
  return o;
});
r.post('/api/invoices', ({ body }) => ({ id: inv.createInvoice(body) }));
r.put('/api/invoices/:id', ({ params, body }) => { inv.updateInvoice(id(params), body); return { ok: true }; });
r.del('/api/invoices/:id', ({ params }) => { inv.deleteDraft(id(params)); return { ok: true }; });
r.post('/api/invoices/:id/approve', ({ params, body }) => { inv.approve(id(params), body); return { ok: true }; });
r.post('/api/invoices/:id/send', async ({ params }) => {
  const out = await inv.send(id(params));
  return { ok: true, skipped: out.skipped || null, invoice_number: out.invoice?.invoice_number };
});
r.post('/api/invoices/:id/mark-sent', async ({ params, body }) => {
  const o = await inv.markSent(id(params), { sent_to: body.note });
  return { ok: true, invoice_number: o.invoice_number };
});
r.post('/api/invoices/:id/payments', ({ params, body }) => ({ status: inv.recordPayment(id(params), body) }));
r.post('/api/invoices/:id/void', ({ params, body }) => { inv.voidInvoice(id(params), body.reason); return { ok: true }; });
r.post('/api/invoices/:id/credit-notes', async ({ params, body }) => {
  const cn = await inv.createCreditNote(id(params), body);
  return { id: cn.id, credit_number: cn.credit_number };
});
r.get('/api/invoices/:id/pdf', async ({ res, params, query }) => {
  const o = bills.mustGet('outgoing_invoices', id(params));
  if (o.pdf_path) {
    const full = o.is_legacy ? files.resolveInside(config.issuedDir, o.pdf_path) : await inv.ensurePdf(o);
    return files.serveFile(res, full, { download: query.get('download') === '1', name: `${o.invoice_number}.pdf` });
  }
  const view = inv.invoiceView(o);
  sendPdf(res, (await renderInvoice(view)).pdf, `${view.number}.pdf`, query.get('download') === '1');
});
// Word version: French invoices made from the owner's template. Not available for legacy or
// English invoices (those only exist as PDF).
r.get('/api/invoices/:id/docx', async ({ res, params, query }) => {
  const o = bills.mustGet('outgoing_invoices', id(params));
  if (o.invoice_number) {
    const full = await inv.ensureDocx(o);
    if (!full) throw new HttpError(404, 'no Word version for this invoice (only French invoices made from the template have one)');
    return files.serveFile(res, files.resolveInside(config.issuedDir, path.relative(config.issuedDir, full)), { download: query.get('download') !== '0', name: `${o.invoice_number}.docx` });
  }
  const view = inv.invoiceView(o);
  const { docx } = await renderInvoice(view);
  if (!docx) throw new HttpError(404, 'no Word version for this invoice (only French invoices use the template)');
  sendBuffer(res, docx, `${view.number}.docx`, DOCX_TYPE, true);
});
// Live preview of unsaved editor content. POST because it carries the whole draft.
r.post('/api/invoices/preview', async ({ res, body }) => {
  const base = body.id ? bills.mustGet('outgoing_invoices', Number(body.id)) : {};
  if (base.invoice_number) throw new HttpError(409, 'numbered invoices are previewed from their stored PDF');
  sendPdf(res, (await renderInvoice(inv.previewView(body, base))).pdf, 'preview.pdf');
});
r.get('/api/credit-notes/:id/pdf', async ({ res, params, query }) => {
  const cn = bills.mustGet('credit_notes', id(params));
  const full = path.join(config.issuedDir, cn.pdf_path);
  if (!fs.existsSync(full)) inv.writeIssuedPdf(cn.pdf_path, await renderInvoicePdf(inv.creditNoteView(cn, bills.mustGet('outgoing_invoices', cn.invoice_id))));
  files.serveFile(res, files.resolveInside(config.issuedDir, cn.pdf_path), { download: query.get('download') === '1' });
});

// ------------------------------------------------------------------ settings
r.get('/api/settings', () => ({
  fx_rates: db.getSetting('fx_rates', { EUR: 1 }),
  email_log: db.all('SELECT id, kind, dedupe_key, recipients, subject, status, error, created_at, sent_at FROM email_log ORDER BY id DESC LIMIT 30'),
  job_runs: db.all('SELECT * FROM job_runs ORDER BY id DESC LIMIT 30'),
}));
r.put('/api/settings/fx', ({ body }) => {
  const rates = { EUR: 1 };
  for (const cur of ['USD', 'TND', 'VND']) {
    const v = Number(String(body[cur] ?? '').replace(',', '.'));
    if (!(v > 0)) throw new HttpError(400, `${cur} rate must be a positive number`);
    rates[cur] = v;
  }
  db.setSetting('fx_rates', { ...rates, updated: D.today(), source: 'manual' });
  return { ok: true };
});
r.post('/api/settings/password', ({ session, body }) => {
  auth.changePassword(session.user.id, body.current, body.next);
  return { ok: true, relogin: true };
});
r.post('/api/settings/test-email', async () => {
  const mailer = require('./lib/mailer');
  const out = await mailer.notifyOwner({
    kind: 'test', dedupeKey: `test:${Date.now()}`,
    subject: 'FinTrack test email', text: `SMTP works. Sent from ${config.publicUrl} at ${new Date().toISOString()}.`,
  });
  return { ok: true, ...out };
});

module.exports = r;
