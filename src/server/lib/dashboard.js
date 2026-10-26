// Dashboard numbers, calendar events and warnings. Everything is computed on request from the
// tables; recurring bills and schedules are expanded into their dated occurrences.
const db = require('../db');
const D = require('../../shared/dates.mjs');
const { toEurMinor } = require('../../shared/money.mjs');
const { billWarnings, billsWithCards, parseList } = require('./bills');
const inv = require('./invoices');

function fxRates() {
  return db.getSetting('fx_rates', { EUR: 1 });
}

// Due dates of a bill between from and to (inclusive), starting at its open occurrence.
function billOccurrences(b, from, to) {
  if (b.status === 'cancelled' || b.status === 'paid') return [];
  const out = [];
  let d = b.due_date;
  for (let i = 0; d && d <= to && i < 400; i++) {
    if (d >= from) out.push(d);
    d = D.nextOccurrence(d, b.billing_cycle, b.anchor_day);
  }
  return out;
}

// Upcoming send dates of a schedule between from and to.
function scheduleOccurrences(s, from, to) {
  if (!s.active) return [];
  const out = [];
  let d = s.next_run_date;
  for (let i = 0; d && d <= to && i < 60; i++) {
    if (d >= from) out.push(d);
    d = inv.followingSendDate(s, d);
  }
  return out;
}

function scheduleTotal(s) {
  const items = parseList(s.line_items);
  return inv.computeTotals(items, parseList(s.tax_lines)).total;
}

function addTo(map, currency, minor) {
  if (minor === null || minor === undefined) return;
  map[currency] = (map[currency] || 0) + minor;
}

function eurTotal(map, rates) {
  let total = 0;
  const missing = [];
  for (const [cur, minor] of Object.entries(map)) {
    const e = toEurMinor(minor, cur, rates);
    if (e === null) missing.push(cur);
    else total += e;
  }
  return { total, missing };
}

function summary(today = D.today()) {
  const rates = fxRates();
  const nmStart = D.addMonths(D.monthStart(today), 1);
  const nmEnd = D.monthEnd(nmStart);
  const horizon = D.addDays(today, 60);

  const bills = billsWithCards();
  const schedules = db.all(`SELECT s.*, c.company_name FROM recurring_invoice_schedules s JOIN clients c ON c.id = s.client_id`);
  const open = db.all(`SELECT o.*, c.company_name FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id
                       WHERE o.status IN ('sent','partially_paid','overdue')`);
  const pending = db.all(`SELECT o.*, c.company_name FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id
                          WHERE o.status IN ('draft','pending_approval','approved') ORDER BY o.scheduled_send_date`);

  // --- bills to pay next month
  const billsNext = {};
  let billsNextUnknown = 0;
  for (const b of bills) {
    for (const d of billOccurrences(b, nmStart, nmEnd)) {
      if (b.amount === null) billsNextUnknown++;
      addTo(billsNext, b.currency, b.amount);
    }
  }

  // --- upcoming and overdue bills
  const upcoming = [];
  for (const b of bills) {
    if (b.status === 'cancelled' || b.status === 'paid') continue;
    if (b.due_date > horizon) continue;
    upcoming.push({
      id: b.id, title: b.title, vendor: b.vendor, receiver_name: b.receiver_name, receiver_country: b.receiver_country,
      amount: b.amount, currency: b.currency, due_date: b.due_date, days_left: D.diffDays(today, b.due_date),
      status: b.due_date < today ? 'overdue' : b.status,
      card: b.payment_card_id ? { id: b.payment_card_id, label: b.card_label, last4: b.card_last4, status: b.card_status } : null,
      warnings: billWarnings(b, today),
    });
  }
  const overdueBills = upcoming.filter((b) => b.days_left < 0);

  // --- income: invoices scheduled next month + open invoices falling due next month
  const incomeNext = {};
  for (const s of schedules) {
    for (const d of scheduleOccurrences(s, nmStart, nmEnd)) {
      const already = db.get('SELECT 1 FROM outgoing_invoices WHERE schedule_id = ? AND period_key = ?', s.id, d.slice(0, 7));
      if (!already) addTo(incomeNext, s.currency, scheduleTotal(s));
    }
  }
  for (const o of pending) if ((o.scheduled_send_date || '') >= nmStart && (o.scheduled_send_date || '') <= nmEnd) addTo(incomeNext, o.currency, o.total);
  for (const o of open) if (o.due_date >= nmStart && o.due_date <= nmEnd) addTo(incomeNext, o.currency, o.total - o.amount_received);

  const unpaid = {};
  const overdueRecv = {};
  const overdueInvoices = [];
  for (const o of open) {
    const left = o.total - o.amount_received - inv.creditedTotal(o.id);
    addTo(unpaid, o.currency, left);
    if (o.due_date < today) {
      addTo(overdueRecv, o.currency, left);
      overdueInvoices.push({ id: o.id, number: o.invoice_number, client: o.company_name, amount: left, currency: o.currency, due_date: o.due_date, days_late: D.diffDays(o.due_date, today) });
    }
  }

  const billsEur = eurTotal(billsNext, rates);
  const incomeEur = eurTotal(incomeNext, rates);

  // --- outgoing invoices about to happen
  const outgoing = [];
  for (const o of pending) {
    outgoing.push({ id: o.id, client: o.company_name, status: o.status, send_date: o.scheduled_send_date, total: o.total, currency: o.currency, number: o.invoice_number });
  }
  for (const s of schedules) {
    for (const d of scheduleOccurrences(s, today, horizon)) {
      if (db.get('SELECT 1 FROM outgoing_invoices WHERE schedule_id = ? AND period_key = ?', s.id, d.slice(0, 7))) continue;
      outgoing.push({
        schedule_id: s.id, client: s.company_name, status: 'scheduled', mode: s.mode, send_date: d,
        draft_date: s.mode === 'approve_first' ? D.addDays(d, -s.approval_lead_days) : null,
        total: scheduleTotal(s), currency: s.currency,
      });
    }
  }
  outgoing.sort((a, b) => (a.send_date || '').localeCompare(b.send_date || ''));

  // --- warnings
  const warnings = [];
  for (const b of upcoming) {
    for (const w of b.warnings) {
      if (w.text === 'overdue' || w.level === 'info') continue;
      warnings.push({ level: w.level, text: `${b.vendor}: ${w.text}`, link: `/bills?id=${b.id}` });
    }
  }
  for (const b of overdueBills) warnings.push({ level: 'danger', text: `${b.vendor} bill is ${-b.days_left} day(s) overdue`, link: `/bills?id=${b.id}` });
  for (const o of pending.filter((p) => p.status === 'pending_approval')) {
    warnings.push({ level: 'warn', text: `Invoice for ${o.company_name} is waiting for your approval (send date ${o.scheduled_send_date})`, link: `/invoices/${o.id}` });
  }
  for (const o of overdueInvoices) warnings.push({ level: 'danger', text: `${o.number} (${o.client}) is ${o.days_late} day(s) past due`, link: `/invoices/${o.id}` });
  for (const s of schedules.filter((x) => x.active && !parseList(x.line_items).length)) {
    warnings.push({ level: 'warn', text: `Schedule for ${s.company_name} has no line items`, link: '/schedules' });
  }

  return {
    today,
    next_month: { start: nmStart, end: nmEnd },
    rates,
    kpis: {
      bills_next_month: { by_currency: billsNext, eur: billsEur.total, missing_rates: billsEur.missing, unknown_amounts: billsNextUnknown },
      upcoming_bills: upcoming.filter((b) => b.days_left >= 0).length,
      overdue_bills: overdueBills.length,
      income_next_month: { by_currency: incomeNext, eur: incomeEur.total, missing_rates: incomeEur.missing },
      unpaid_invoices: { by_currency: unpaid, eur: eurTotal(unpaid, rates).total, count: open.length },
      overdue_receivables: { by_currency: overdueRecv, eur: eurTotal(overdueRecv, rates).total, count: overdueInvoices.length },
      net_projection_eur: incomeEur.total - billsEur.total,
    },
    upcoming_bills: upcoming,
    outgoing,
    warnings,
  };
}

// Calendar events for one month: bills due, invoices to send (and draft dates), invoices due.
function calendar(month) {
  const start = `${month}-01`;
  const end = D.monthEnd(start);
  const events = [];
  for (const b of billsWithCards()) {
    for (const d of billOccurrences(b, start, end)) {
      events.push({ date: d, kind: 'bill', title: b.vendor, amount: b.amount, currency: b.currency, link: `/bills?id=${b.id}`, warn: billWarnings(b).some((w) => w.level === 'danger') });
    }
  }
  const schedules = db.all('SELECT s.*, c.company_name FROM recurring_invoice_schedules s JOIN clients c ON c.id = s.client_id');
  for (const s of schedules) {
    for (const d of scheduleOccurrences(s, start, D.addDays(end, 14))) {
      if (db.get('SELECT 1 FROM outgoing_invoices WHERE schedule_id = ? AND period_key = ?', s.id, d.slice(0, 7))) continue;
      if (d <= end) events.push({ date: d, kind: 'invoice_send', title: `Send ${s.company_name}`, amount: scheduleTotal(s), currency: s.currency, link: '/schedules' });
      const draft = s.mode === 'approve_first' ? D.addDays(d, -s.approval_lead_days) : null;
      if (draft && draft >= start && draft <= end) events.push({ date: draft, kind: 'invoice_draft', title: `Draft ${s.company_name}`, link: '/approvals' });
    }
  }
  for (const o of db.all(`SELECT o.*, c.company_name FROM outgoing_invoices o JOIN clients c ON c.id = o.client_id WHERE o.status != 'void'`)) {
    if (!o.sent_at && o.scheduled_send_date >= start && o.scheduled_send_date <= end) {
      events.push({ date: o.scheduled_send_date, kind: 'invoice_send', title: `Send ${o.company_name}`, amount: o.total, currency: o.currency, link: `/invoices/${o.id}`, warn: o.status === 'pending_approval' });
    }
    if (o.sent_at && !['paid', 'void'].includes(o.status) && o.due_date >= start && o.due_date <= end) {
      events.push({ date: o.due_date, kind: 'invoice_due', title: `${o.invoice_number} due`, amount: o.total - o.amount_received, currency: o.currency, link: `/invoices/${o.id}` });
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { summary, calendar, billOccurrences, scheduleOccurrences, fxRates };
