// Outgoing invoices: issuer profiles, clients, recurring schedules, the invoice lifecycle
// (draft -> pending_approval -> approved -> sent -> paid/partially_paid/overdue, or void),
// gapless numbering, payments and credit notes.
//
// Numbering rule: an invoice gets its number at the moment it is finalized (sent by email or
// marked as sent by hand), inside one IMMEDIATE transaction that also bumps the counter. Drafts
// carry no number, so deleting a draft can never leave a gap, and numbers follow issue dates.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const { clean, HttpError } = require('./validate');
const { mustGet, parseList } = require('./bills');
const D = require('../../shared/dates.mjs');
const { toMinor, lineAmount, formatMoney } = require('../../shared/money.mjs');

const ISSUER_FIELDS = {
  prefix: { type: 'text', required: true, max: 8 },
  legal_name: { type: 'text', required: true, max: 120 },
  title_line: { type: 'text', max: 160 },
  address: { type: 'text', max: 400 },
  country: { type: 'country' },
  tax_id: { type: 'text', max: 60 },
  email: { type: 'email' },
  phone: { type: 'text', max: 40 },
  bank_beneficiary: { type: 'text', max: 120 },
  bank_name: { type: 'text', max: 160 },
  bank_iban: { type: 'text', max: 60 },
  bank_swift: { type: 'text', max: 20 },
  bank_account: { type: 'text', max: 60 },
  bank_address: { type: 'text', max: 300 },
  bank_currency: { type: 'text', max: 10 },
  bank_extra: { type: 'text', max: 500 },
  payment_note: { type: 'text', max: 1500 },
  footer_text: { type: 'text', max: 1500 },
  number_format: { type: 'text', max: 60, default: '{PREFIX}-{YYYY}-{NNNN}' },
  credit_format: { type: 'text', max: 60, default: '{PREFIX}-CN-{YYYY}-{NNNN}' },
  default_currency: { type: 'currency', default: 'EUR' },
  is_default: { type: 'bool' },
};

const CLIENT_FIELDS = {
  company_name: { type: 'text', required: true, max: 160 },
  contact_name: { type: 'text', max: 120 },
  billing_emails: { type: 'emails' },
  cc_emails: { type: 'emails' },
  phone: { type: 'text', max: 40 },
  address: { type: 'text', max: 400 },
  country: { type: 'country' },
  registration_id: { type: 'text', max: 60 },
  vat_number: { type: 'text', max: 40 },
  currency: { type: 'currency', default: 'EUR' },
  payment_terms_days: { type: 'int', min: 0, max: 365, default: 30 },
  legal_mentions: { type: 'text', max: 2000 },
  invoice_note: { type: 'text', max: 2000 },
  language: { type: 'enum', values: ['FR', 'EN'], default: 'EN' },
  default_issuer_profile_id: { type: 'int', min: 1 },
  client_reminders: { type: 'bool' },
  notes: { type: 'text', max: 4000 },
};

const SCHEDULE_FIELDS = {
  name: { type: 'text', max: 120 },
  client_id: { type: 'int', min: 1, required: true },
  issuer_profile_id: { type: 'int', min: 1, required: true },
  currency: { type: 'currency', default: 'EUR' },
  frequency: { type: 'enum', values: ['monthly', 'quarterly', 'custom'], default: 'monthly' },
  interval_months: { type: 'int', min: 1, max: 24, default: 1 },
  send_rule: { type: 'enum', values: ['last_business_day', 'fixed_day'], default: 'last_business_day' },
  send_day: { type: 'int', min: 1, max: 31 },
  mode: { type: 'enum', values: ['auto_send', 'approve_first'], default: 'approve_first' },
  approval_lead_days: { type: 'int', min: 0, max: 14, default: 3 },
  active: { type: 'bool', default: 1 },
  next_run_date: { type: 'date' },
  notes: { type: 'text', max: 2000 },
};

const EDITABLE = ['draft', 'pending_approval', 'approved'];

// ------------------------------------------------------------------ line items and totals

// Accepts unit_price as a decimal string/number ("1627,00") or, with priceInMinor, as minor units.
function cleanLineItems(items, currency, { priceInMinor = false } = {}) {
  if (!Array.isArray(items)) throw new HttpError(400, 'line_items must be a list');
  if (items.length > 50) throw new HttpError(400, 'at most 50 line items');
  return items.map((it, i) => {
    const description = String(it.description ?? '').trim();
    if (!description) throw new HttpError(400, `line ${i + 1}: description is required`);
    const quantity = Number(String(it.quantity ?? 1).replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity < 0) throw new HttpError(400, `line ${i + 1}: quantity must be a number ≥ 0`);
    const unit_price = priceInMinor ? Number(it.unit_price) : toMinor(it.unit_price, currency);
    if (unit_price === null || !Number.isFinite(unit_price)) throw new HttpError(400, `line ${i + 1}: unit price must be an amount`);
    return {
      description: description.slice(0, 1000),
      detail: String(it.detail ?? '').trim().slice(0, 2000) || undefined,
      quantity: Math.round(quantity * 1000) / 1000,
      unit: String(it.unit ?? '').trim().slice(0, 20) || undefined,
      unit_price,
      variable_quantity: it.variable_quantity ? true : undefined,
    };
  });
}

function cleanTaxLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((t, i) => {
    const rate = Number(String(t.rate ?? '').replace(',', '.'));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpError(400, `tax line ${i + 1}: rate must be a percentage`);
    const label = String(t.label ?? '').trim();
    if (!label) throw new HttpError(400, `tax line ${i + 1}: label is required`);
    return { label: label.slice(0, 120), rate };
  });
}

function computeTotals(lineItems, taxLines) {
  const items = lineItems.map((it) => ({ ...it, amount: lineAmount(it.quantity, it.unit_price) }));
  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const taxes = taxLines.map((t) => ({ ...t, amount: Math.round((subtotal * t.rate) / 100) }));
  const tax_total = taxes.reduce((s, t) => s + t.amount, 0);
  return { line_items: items, subtotal, tax_lines: taxes, tax_total, total: subtotal + tax_total };
}

// ------------------------------------------------------------------ issuers & clients

function cleanIssuer(body, opts) {
  const row = clean(ISSUER_FIELDS, body, opts);
  if (row.prefix !== undefined) {
    row.prefix = String(row.prefix).toUpperCase();
    if (!/^[A-Z]{2,8}$/.test(row.prefix)) throw new HttpError(400, 'prefix must be 2–8 letters', { prefix: '2–8 letters A–Z' });
  }
  if (row.number_format) checkFormat(row.number_format);
  if (row.credit_format) checkFormat(row.credit_format);
  return row;
}

function saveIssuer(id, body) {
  return db.tx(() => {
    const row = cleanIssuer(body, { partial: !!id });
    if (id) {
      const existing = mustGet('issuer_profiles', id);
      // the prefix is part of every number already issued; freeze it once used
      if (row.prefix && row.prefix !== existing.prefix && db.get('SELECT 1 FROM invoice_counters WHERE issuer_profile_id = ? AND last_number > 0', id)) {
        throw new HttpError(409, 'prefix cannot change after invoices were numbered with it');
      }
    }
    if (row.is_default) db.run('UPDATE issuer_profiles SET is_default = 0 WHERE is_default = 1');
    if (id) {
      db.update('issuer_profiles', id, row);
      return Number(id);
    }
    return db.insert('issuer_profiles', row);
  });
}

function saveClient(id, body) {
  const row = clean(CLIENT_FIELDS, body, { partial: !!id });
  if (row.default_issuer_profile_id) mustGet('issuer_profiles', row.default_issuer_profile_id);
  if (id) {
    mustGet('clients', id);
    db.update('clients', id, row);
    return Number(id);
  }
  return db.insert('clients', row);
}

// ------------------------------------------------------------------ schedules

function sendDateInMonth(schedule, anyDayOfMonth) {
  if (schedule.send_rule === 'fixed_day') {
    const { y, m } = D.parse(anyDayOfMonth);
    return D.ymd(y, m, Math.min(schedule.send_day || 1, D.daysInMonth(y, m)));
  }
  return D.lastBusinessDay(anyDayOfMonth);
}

function stepMonths(schedule) {
  if (schedule.frequency === 'monthly') return 1;
  if (schedule.frequency === 'quarterly') return 3;
  return schedule.interval_months || 1;
}

// First send date on or after `from`.
function firstSendDate(schedule, from) {
  let d = sendDateInMonth(schedule, from);
  if (d < from) d = sendDateInMonth(schedule, D.addMonths(D.monthStart(from), 1));
  return d;
}

function followingSendDate(schedule, sendDate) {
  return sendDateInMonth(schedule, D.addMonths(D.monthStart(sendDate), stepMonths(schedule)));
}

// Service period billed by the invoice sent on `sendDate`: the months ending with the send month.
function periodFor(schedule, sendDate) {
  const n = stepMonths(schedule);
  return {
    start: D.addMonths(D.monthStart(sendDate), -(n - 1)),
    end: D.monthEnd(sendDate),
    key: sendDate.slice(0, 7),
  };
}

function saveSchedule(id, body) {
  return db.tx(() => {
    const existing = id ? mustGet('recurring_invoice_schedules', id) : null;
    const row = clean(SCHEDULE_FIELDS, body, { partial: !!id });
    const merged = { ...existing, ...row };
    const client = mustGet('clients', merged.client_id);
    mustGet('issuer_profiles', merged.issuer_profile_id);
    if (merged.send_rule === 'fixed_day' && !merged.send_day) throw new HttpError(400, 'send_day is required for a fixed day', { send_day: 'required' });
    if (body.line_items !== undefined) row.line_items = JSON.stringify(cleanLineItems(body.line_items, merged.currency || client.currency));
    if (body.tax_lines !== undefined) row.tax_lines = JSON.stringify(cleanTaxLines(body.tax_lines));
    if (!merged.next_run_date || body.recompute_next_run) row.next_run_date = firstSendDate(merged, D.today());
    if (id) {
      db.update('recurring_invoice_schedules', id, row);
      return Number(id);
    }
    if (row.active === undefined) row.active = 1;
    return db.insert('recurring_invoice_schedules', row);
  });
}

// "{month} {year}" -> "octobre 2026"; "{Month}" capitalised; "{period}" -> "01–31 octobre 2026"
function fillPlaceholders(text, period, lang) {
  const { y, m } = D.parse(period.end);
  const month = D.monthName(m, lang);
  const s = D.parse(period.start);
  const range = period.start.slice(0, 7) === period.end.slice(0, 7)
    ? `${String(s.d).padStart(2, '0')}–${D.parse(period.end).d} ${month} ${y}`
    : `${D.formatDate(period.start, lang)} – ${D.formatDate(period.end, lang)}`;
  return String(text)
    .replaceAll('{Month}', month.charAt(0).toUpperCase() + month.slice(1))
    .replaceAll('{month}', month)
    .replaceAll('{year}', String(y))
    .replaceAll('{period}', range);
}

// Builds (and unless dryRun, inserts) the invoice for one schedule occurrence.
// Returns { invoice, created } where created=false means it already existed (idempotent).
function draftFromSchedule(schedule, sendDate, { dryRun = false, actor = 'automation' } = {}) {
  const period = periodFor(schedule, sendDate);
  const existing = db.get('SELECT * FROM outgoing_invoices WHERE schedule_id = ? AND period_key = ?', schedule.id, period.key);
  if (existing) return { invoice: existing, created: false };

  const client = mustGet('clients', schedule.client_id);
  const lang = client.language;
  const template = parseList(schedule.line_items);
  const items = template.map((it) => ({
    ...it,
    description: fillPlaceholders(it.description, period, lang),
    detail: it.detail ? fillPlaceholders(it.detail, period, lang) : undefined,
  }));
  const totals = computeTotals(items, parseList(schedule.tax_lines));
  const needsReview = schedule.mode === 'approve_first' || template.some((it) => it.variable_quantity);
  const row = {
    client_id: client.id,
    issuer_profile_id: schedule.issuer_profile_id,
    schedule_id: schedule.id,
    period_key: period.key,
    language: lang,
    currency: schedule.currency,
    scheduled_send_date: sendDate,
    service_period_start: period.start,
    service_period_end: period.end,
    line_items: JSON.stringify(totals.line_items),
    subtotal: totals.subtotal,
    tax_lines: JSON.stringify(totals.tax_lines),
    tax_total: totals.tax_total,
    total: totals.total,
    legal_mentions: client.legal_mentions,
    invoice_note: client.invoice_note,
    status: needsReview ? 'pending_approval' : 'approved',
    approved_at: needsReview ? null : new Date().toISOString(),
  };
  if (dryRun) return { invoice: { id: null, ...row }, created: true };
  const id = db.tx(() => {
    const newId = db.insert('outgoing_invoices', row);
    logEvent(newId, 'created', { schedule_id: schedule.id, period: period.key, send_date: sendDate, mode: schedule.mode }, actor);
    db.update('recurring_invoice_schedules', schedule.id, { next_run_date: followingSendDate(schedule, sendDate) });
    return newId;
  });
  return { invoice: mustGet('outgoing_invoices', id), created: true };
}

// ------------------------------------------------------------------ manual invoices

function cleanInvoiceBody(body, base = {}) {
  const merged = { ...base, ...body };
  const row = clean({
    client_id: { type: 'int', min: 1, required: true },
    issuer_profile_id: { type: 'int', min: 1, required: true },
    language: { type: 'enum', values: ['FR', 'EN'] },
    currency: { type: 'currency' },
    service_period_start: { type: 'date' },
    service_period_end: { type: 'date' },
    scheduled_send_date: { type: 'date' },
    legal_mentions: { type: 'text', max: 2000 },
    invoice_note: { type: 'text', max: 2000 },
    notes: { type: 'text', max: 4000 },
  }, merged);
  const client = mustGet('clients', row.client_id);
  mustGet('issuer_profiles', row.issuer_profile_id);
  row.language ||= client.language;
  row.currency ||= client.currency;
  if (body.legal_mentions === undefined && !base.id) row.legal_mentions = client.legal_mentions;
  if (body.invoice_note === undefined && !base.id) row.invoice_note = client.invoice_note;
  const items = body.line_items !== undefined
    ? cleanLineItems(body.line_items, row.currency)
    : parseList(base.line_items);
  const taxes = body.tax_lines !== undefined ? cleanTaxLines(body.tax_lines) : parseList(base.tax_lines).map(({ label, rate }) => ({ label, rate }));
  const totals = computeTotals(items, taxes);
  Object.assign(row, {
    line_items: JSON.stringify(totals.line_items),
    subtotal: totals.subtotal,
    tax_lines: JSON.stringify(totals.tax_lines),
    tax_total: totals.tax_total,
    total: totals.total,
  });
  return row;
}

// PDF view of unsaved editor content (live preview), on top of an existing invoice or from scratch.
function previewView(body, base = {}) {
  const row = cleanInvoiceBody(body, base);
  return invoiceView({ ...base, ...row, invoice_number: base.invoice_number || null });
}

function createInvoice(body) {
  const row = cleanInvoiceBody(body);
  row.status = 'draft';
  const id = db.insert('outgoing_invoices', row);
  logEvent(id, 'created', { manual: true });
  return id;
}

function updateInvoice(id, body) {
  const inv = mustGet('outgoing_invoices', id);
  if (!EDITABLE.includes(inv.status) || inv.invoice_number) {
    throw new HttpError(409, 'only unnumbered drafts can be edited; issue a credit note to correct a sent invoice');
  }
  const row = cleanInvoiceBody(body, inv);
  db.update('outgoing_invoices', id, row);
  logEvent(id, 'edited', { total: row.total });
}

function deleteDraft(id) {
  const inv = mustGet('outgoing_invoices', id);
  if (inv.invoice_number || !EDITABLE.includes(inv.status)) throw new HttpError(409, 'only unnumbered drafts can be deleted');
  db.tx(() => {
    db.run('DELETE FROM invoice_events WHERE invoice_id = ?', id);
    db.run('DELETE FROM outgoing_invoices WHERE id = ?', id);
  });
}

function approve(id, body = {}) {
  const inv = mustGet('outgoing_invoices', id);
  if (!['draft', 'pending_approval'].includes(inv.status)) throw new HttpError(409, `cannot approve an invoice that is ${inv.status}`);
  if (body.line_items || body.tax_lines) updateInvoice(id, body);
  db.update('outgoing_invoices', id, { status: 'approved', approved_at: new Date().toISOString() });
  logEvent(id, 'approved', {});
}

// ------------------------------------------------------------------ finalize (number + PDF)

function snapshotIssuer(issuer) {
  const { id, created_at, updated_at, is_default, ...rest } = issuer;
  return rest;
}

function snapshotClient(client) {
  const { company_name, contact_name, address, country, registration_id, vat_number, phone, billing_emails } = client;
  return { company_name, contact_name, address, country, registration_id, vat_number, phone, billing_emails: parseList(billing_emails) };
}

// Number formats (per issuer): {PREFIX} {YYYY} {YY} {MM} and {N…}, e.g. 'INV-{YYYY}-{MM}-{NNN}'.
const SEQ = /\{(N+)\}/;

function checkFormat(format) {
  if (!SEQ.test(format)) throw new HttpError(400, 'number format needs a sequence token like {NNN}');
  const unknown = format.replace(/\{(PREFIX|YYYY|YY|MM|N+)\}/g, '').match(/\{[^}]*\}/);
  if (unknown) throw new HttpError(400, `unknown token ${unknown[0]} in number format`);
}

const formatOf = (issuer, kind) => (kind === 'credit_note' ? issuer.credit_format : issuer.number_format);

// The counter restarts each month when the format shows the month, each year otherwise.
function periodOf(format, date) {
  if (format.includes('{MM}')) return date.slice(0, 7);
  if (format.includes('{YYYY}') || format.includes('{YY}')) return date.slice(0, 4);
  return 'all';
}

function formatNumber(issuer, kind, date, n) {
  return formatOf(issuer, kind)
    .replaceAll('{PREFIX}', issuer.prefix)
    .replaceAll('{YYYY}', date.slice(0, 4))
    .replaceAll('{YY}', date.slice(2, 4))
    .replaceAll('{MM}', date.slice(5, 7))
    .replace(SEQ, (_, ns) => String(n).padStart(ns.length, '0'));
}

const numberTaken = (number) => db.get('SELECT 1 FROM outgoing_invoices WHERE invoice_number = ? UNION ALL SELECT 1 FROM credit_notes WHERE credit_number = ?', number, number);

// Next number WITHOUT reserving it (dry runs and previews). `date` is the issue date.
function peekNumber(issuerId, date, kind = 'invoice') {
  const issuer = mustGet('issuer_profiles', issuerId);
  const period = periodOf(formatOf(issuer, kind), date);
  const row = db.get('SELECT last_number FROM invoice_counters WHERE issuer_profile_id = ? AND kind = ? AND period = ?', issuerId, kind, period);
  let n = (row?.last_number || 0) + 1;
  while (numberTaken(formatNumber(issuer, kind, date, n))) n++;
  return formatNumber(issuer, kind, date, n);
}

// Must be called inside db.tx(). Bumps the counter and returns the new number. Numbers already
// used (e.g. imported legacy invoices) are stepped over, never reused.
function takeNumber(issuerId, date, kind = 'invoice') {
  const issuer = mustGet('issuer_profiles', issuerId);
  const period = periodOf(formatOf(issuer, kind), date);
  for (;;) {
    db.run(`INSERT INTO invoice_counters (issuer_profile_id, kind, period, last_number) VALUES (?, ?, ?, 1)
            ON CONFLICT(issuer_profile_id, kind, period) DO UPDATE SET last_number = last_number + 1`, issuerId, kind, period);
    const { last_number } = db.get('SELECT last_number FROM invoice_counters WHERE issuer_profile_id = ? AND kind = ? AND period = ?', issuerId, kind, period);
    const number = formatNumber(issuer, kind, date, last_number);
    if (!numberTaken(number)) return number;
  }
}

function issuedPath(issuerId, number, issueDate) {
  const { prefix } = mustGet('issuer_profiles', issuerId);
  return path.join(prefix, issueDate.slice(0, 4), `${number}.pdf`);
}

// Writes an issued document. Existing files are never overwritten: issued PDFs are permanent.
function writeIssuedPdf(rel, buffer) {
  const full = path.join(config.issuedDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer, { flag: 'wx' });
  return rel;
}

// Gives an approved/draft invoice its number, issue date, due date and snapshots, renders and
// stores the PDF. Idempotent: an invoice that already has a number is returned unchanged.
async function finalize(id, { today = D.today(), actor = 'user' } = {}) {
  let inv = mustGet('outgoing_invoices', id);
  if (inv.invoice_number) return inv;
  if (!EDITABLE.includes(inv.status)) throw new HttpError(409, `cannot finalize an invoice that is ${inv.status}`);
  if (!parseList(inv.line_items).length) throw new HttpError(409, 'invoice has no line items');
  const issuer = mustGet('issuer_profiles', inv.issuer_profile_id);
  const client = mustGet('clients', inv.client_id);
  const issueDate = today;

  // Number, dates and frozen snapshots are committed together. The PDF is rendered right after
  // (pdfkit is async); if that fails, ensurePdf() re-creates it from the snapshot on the next try.
  const { rel, view } = db.tx(() => {
    const number = takeNumber(issuer.id, issueDate);
    const fields = {
      invoice_number: number,
      issue_date: issueDate,
      due_date: D.addDays(issueDate, client.payment_terms_days),
      issuer_snapshot: JSON.stringify(snapshotIssuer(issuer)),
      client_snapshot: JSON.stringify(snapshotClient(client)),
      pdf_path: issuedPath(issuer.id, number, issueDate),
      status: 'approved',
      approved_at: inv.approved_at || new Date().toISOString(),
    };
    db.update('outgoing_invoices', id, fields);
    logEvent(id, 'numbered', { invoice_number: number }, actor);
    return { rel: fields.pdf_path, view: invoiceView({ ...inv, ...fields }) };
  });
  await writeDocuments(rel, view);
  inv = mustGet('outgoing_invoices', id);
  return inv;
}

const docxPathOf = (pdfRel) => pdfRel.replace(/\.pdf$/, '.docx');

// Renders an issued invoice (PDF, plus .docx for template invoices) and stores whatever is
// missing. Existing files are never overwritten.
async function writeDocuments(pdfRel, view) {
  const { renderInvoice } = require('./render');
  const { pdf, docx } = await renderInvoice(view);
  for (const [rel, buf] of [[pdfRel, pdf], [docxPathOf(pdfRel), docx]]) {
    if (!buf) continue;
    try {
      writeIssuedPdf(rel, buf);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

// Re-creates missing files of a numbered invoice from its frozen snapshot (never overwrites).
async function ensurePdf(inv) {
  if (!inv.pdf_path) return null;
  const full = path.join(config.issuedDir, inv.pdf_path);
  if (inv.is_legacy) return full;
  const { usesTemplate } = require('./render');
  const view = invoiceView(inv);
  const docxMissing = usesTemplate(view) && !fs.existsSync(path.join(config.issuedDir, docxPathOf(inv.pdf_path)));
  if (!fs.existsSync(full) || docxMissing) await writeDocuments(inv.pdf_path, view);
  return full;
}

// Path of the stored .docx of a numbered invoice, or null when it has none (legacy, English).
async function ensureDocx(inv) {
  if (!inv.pdf_path || inv.is_legacy) return null;
  await ensurePdf(inv);
  const full = path.join(config.issuedDir, docxPathOf(inv.pdf_path));
  return fs.existsSync(full) ? full : null;
}

// Everything the PDF template and the emails need, from snapshots when frozen.
function invoiceView(inv) {
  const issuer = inv.issuer_snapshot ? JSON.parse(inv.issuer_snapshot) : snapshotIssuer(mustGet('issuer_profiles', inv.issuer_profile_id));
  const clientRow = mustGet('clients', inv.client_id);
  const client = inv.client_snapshot ? JSON.parse(inv.client_snapshot) : snapshotClient(clientRow);
  const terms = clientRow.payment_terms_days;
  return {
    kind: 'invoice',
    // drafts show the next free number (assigned for real at send time; no watermark)
    number: inv.invoice_number || peekNumber(inv.issuer_profile_id, inv.issue_date || D.today()),
    draft: !inv.invoice_number,
    language: inv.language,
    currency: inv.currency,
    issue_date: inv.issue_date || inv.scheduled_send_date || D.today(),
    due_date: inv.due_date || D.addDays(inv.issue_date || inv.scheduled_send_date || D.today(), terms),
    payment_terms_days: terms,
    service_period_start: inv.service_period_start,
    service_period_end: inv.service_period_end,
    line_items: parseList(inv.line_items),
    subtotal: inv.subtotal,
    tax_lines: parseList(inv.tax_lines),
    tax_total: inv.tax_total,
    total: inv.total,
    legal_mentions: inv.legal_mentions,
    invoice_note: inv.invoice_note,
    issuer,
    client,
  };
}

// ------------------------------------------------------------------ sending

async function send(id, { today = D.today(), dryRun = false, actor = 'user' } = {}) {
  const mailer = require('./mailer');
  const templates = require('./templates');
  let inv = mustGet('outgoing_invoices', id);
  if (inv.sent_at) return { skipped: 'already sent', invoice: inv };
  if (inv.status !== 'approved') throw new HttpError(409, `invoice must be approved before sending (it is ${inv.status})`);
  const client = mustGet('clients', inv.client_id);
  const to = parseList(client.billing_emails);
  const cc = parseList(client.cc_emails);
  if (!to.length) throw new HttpError(409, `client ${client.company_name} has no billing email; add one or mark the invoice as sent manually`);

  if (dryRun) {
    const number = inv.invoice_number || `${peekNumber(inv.issuer_profile_id, today)} (next free number, not reserved)`;
    return { dryRun: true, would: { number, to, cc, bcc: [config.ownerEmail], total: formatMoney(inv.total, inv.currency, inv.language) } };
  }

  inv = await finalize(id, { today, actor });
  const full = await ensurePdf(inv);
  const view = invoiceView(inv);
  const mail = templates.invoiceEmail(view);
  const result = await mailer.send({
    kind: 'invoice',
    dedupeKey: `invoice-send:${inv.id}`,
    to, cc, bcc: [config.ownerEmail],
    subject: mail.subject,
    text: mail.text,
    attachments: [{ filename: `${inv.invoice_number}.pdf`, path: full }],
  });
  if (result.skipped) return { skipped: result.skipped, invoice: inv };
  db.update('outgoing_invoices', id, {
    status: 'sent', sent_at: new Date().toISOString(), sent_to: JSON.stringify({ to, cc }),
  });
  logEvent(id, 'sent', { to, cc, message_id: result.messageId }, actor);
  return { sent: true, invoice: mustGet('outgoing_invoices', id) };
}

// For invoices delivered outside the app (e.g. the client has no email on file yet).
async function markSent(id, { today = D.today(), sent_to = '' } = {}) {
  const inv = await finalize(id, { today });
  if (inv.sent_at) return inv;
  db.update('outgoing_invoices', id, {
    status: 'sent', sent_at: new Date().toISOString(), sent_to: JSON.stringify({ manual: true, note: String(sent_to).slice(0, 200) }),
  });
  logEvent(id, 'sent', { manual: true });
  return mustGet('outgoing_invoices', id);
}

// ------------------------------------------------------------------ payments, void, credit notes

function creditedTotal(invoiceId) {
  return db.get('SELECT COALESCE(SUM(total), 0) AS t FROM credit_notes WHERE invoice_id = ?', invoiceId).t;
}

function settleStatus(inv, received, today = D.today()) {
  const due = inv.total - creditedTotal(inv.id);
  if (due <= 0) return 'void';
  if (received >= due) return 'paid';
  if (received > 0) return 'partially_paid';
  return inv.due_date && inv.due_date < today ? 'overdue' : 'sent';
}

function recordPayment(id, body) {
  return db.tx(() => {
    const inv = mustGet('outgoing_invoices', id);
    if (!inv.sent_at) throw new HttpError(409, 'only sent invoices can receive payments');
    if (inv.status === 'void') throw new HttpError(409, 'invoice is void');
    const p = clean({
      paid_date: { type: 'date', required: true },
      amount: { type: 'money', required: true, min: 1 },
      note: { type: 'text', max: 500 },
    }, { ...body, paid_date: body.paid_date || D.today(), currency: inv.currency });
    if (!p.amount) throw new HttpError(400, 'amount must be greater than zero');
    db.insert('invoice_payments', { invoice_id: inv.id, ...p });
    const received = db.get('SELECT SUM(amount) AS s FROM invoice_payments WHERE invoice_id = ?', inv.id).s;
    const status = settleStatus(inv, received);
    db.update('outgoing_invoices', inv.id, { amount_received: received, status, paid_date: status === 'paid' ? p.paid_date : inv.paid_date });
    logEvent(inv.id, status === 'paid' ? 'paid' : 'payment', { amount: p.amount, paid_date: p.paid_date, received });
    return status;
  });
}

function voidInvoice(id, reason) {
  const inv = mustGet('outgoing_invoices', id);
  if (inv.sent_at) throw new HttpError(409, 'a sent invoice cannot be voided: issue a credit note instead');
  if (inv.status === 'void') return;
  db.update('outgoing_invoices', id, { status: 'void' });
  logEvent(id, 'voided', { reason: String(reason || '').slice(0, 500) });
}

async function createCreditNote(id, body = {}, { today = D.today() } = {}) {
  const { renderInvoicePdf } = require('./pdf');
  const inv = mustGet('outgoing_invoices', id);
  if (!inv.sent_at) throw new HttpError(409, 'credit notes apply to sent invoices; edit or void the draft instead');
  const reason = String(body.reason || '').trim();
  if (!reason) throw new HttpError(400, 'a reason is required', { reason: 'required' });
  const remaining = inv.total - creditedTotal(inv.id);
  if (remaining <= 0) throw new HttpError(409, 'invoice is already fully credited');

  let items;
  let taxes;
  if (body.full !== false && !body.line_items) {
    items = parseList(inv.line_items).map(({ description, detail, quantity, unit, unit_price }) => ({ description, detail, quantity, unit, unit_price }));
    taxes = parseList(inv.tax_lines).map(({ label, rate }) => ({ label, rate }));
  } else {
    items = cleanLineItems(body.line_items || [], inv.currency);
    taxes = cleanTaxLines(body.tax_lines || parseList(inv.tax_lines));
  }
  const totals = computeTotals(items, taxes);
  if (totals.total <= 0) throw new HttpError(400, 'credit note total must be positive');
  if (totals.total > remaining) throw new HttpError(400, `credit exceeds what is left on the invoice (${formatMoney(remaining, inv.currency)})`);

  let cnId;
  let rel;
  db.tx(() => {
    const number = takeNumber(inv.issuer_profile_id, today, 'credit_note');
    rel = issuedPath(inv.issuer_profile_id, number, today);
    cnId = db.insert('credit_notes', {
      credit_number: number, invoice_id: inv.id, issuer_profile_id: inv.issuer_profile_id,
      issue_date: today, reason: reason.slice(0, 1000),
      line_items: JSON.stringify(totals.line_items), subtotal: totals.subtotal,
      tax_lines: JSON.stringify(totals.tax_lines), tax_total: totals.tax_total, total: totals.total,
      currency: inv.currency, pdf_path: rel,
    });
    const status = settleStatus(inv, inv.amount_received);
    db.update('outgoing_invoices', inv.id, { status });
    logEvent(inv.id, 'credit_note', { credit_number: number, total: totals.total, reason }, 'user', cnId);
  });
  const cn = mustGet('credit_notes', cnId);
  writeIssuedPdf(rel, await renderInvoicePdf(creditNoteView(cn, inv)));
  return cn;
}

function creditNoteView(cn, inv) {
  const base = invoiceView(inv);
  return {
    ...base,
    kind: 'credit_note',
    number: cn.credit_number,
    draft: false,
    issue_date: cn.issue_date,
    due_date: null,
    original_number: inv.invoice_number,
    original_date: inv.issue_date,
    reason: cn.reason,
    line_items: parseList(cn.line_items),
    subtotal: cn.subtotal,
    tax_lines: parseList(cn.tax_lines),
    tax_total: cn.tax_total,
    total: cn.total,
  };
}

// Sent invoices past their due date become overdue (daily job + dashboard refresh).
function markOverdue({ today = D.today(), dryRun = false } = {}) {
  // partially paid ones keep their status; the dashboard flags them by date
  const changed = db.all("SELECT id, invoice_number, due_date FROM outgoing_invoices WHERE status = 'sent' AND due_date < ?", today);
  if (!dryRun) {
    for (const r of changed) {
      db.update('outgoing_invoices', r.id, { status: 'overdue' });
      logEvent(r.id, 'overdue', { due_date: r.due_date }, 'automation');
    }
  }
  return changed;
}

function logEvent(invoiceId, type, detail = {}, actor = 'user', creditNoteId = null) {
  db.insert('invoice_events', {
    invoice_id: invoiceId, credit_note_id: creditNoteId, type, detail: JSON.stringify(detail), actor,
  });
}

module.exports = {
  ISSUER_FIELDS, CLIENT_FIELDS, SCHEDULE_FIELDS,
  cleanLineItems, cleanTaxLines, computeTotals,
  saveIssuer, saveClient, saveSchedule,
  sendDateInMonth, firstSendDate, followingSendDate, periodFor, fillPlaceholders, draftFromSchedule,
  createInvoice, updateInvoice, deleteDraft, previewView, approve, finalize, ensurePdf, ensureDocx, docxPathOf, invoiceView, peekNumber,
  send, markSent, recordPayment, voidInvoice, createCreditNote, creditNoteView, creditedTotal,
  markOverdue, logEvent, writeIssuedPdf,
};
