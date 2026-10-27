// Bills (what I pay) and cards: validation, the pay-and-roll-forward rule, overdue
// detection and the card warnings shown on the dashboard and in the month-end report.
const db = require('../db');
const { clean, HttpError } = require('./validate');
const D = require('../../shared/dates.mjs');

const CARD_FIELDS = {
  label: { type: 'text', required: true, max: 80 },
  bank: { type: 'text', max: 80 },
  network: { type: 'text', max: 30 },
  last4: { type: 'text', required: true },
  expiry_month: { type: 'int', min: 1, max: 12 },
  expiry_year: { type: 'int', min: 2000, max: 2100 },
  currency: { type: 'currency' },
  status: { type: 'enum', values: ['active', 'standby', 'blocked', 'expired'], default: 'active' },
  usable_countries: { type: 'countries' },
  notes: { type: 'text', max: 2000 },
};

const BILL_FIELDS = {
  title: { type: 'text', required: true, max: 120 },
  vendor: { type: 'text', required: true, max: 120 },
  receiver_name: { type: 'text', max: 120 },
  receiver_country: { type: 'country' },
  currency: { type: 'currency', required: true },
  amount: { type: 'money', min: 0 },
  billing_cycle: { type: 'enum', values: ['one-time', 'monthly', 'quarterly', 'yearly'], required: true },
  due_date: { type: 'date', required: true },
  status: { type: 'enum', values: ['upcoming', 'paid', 'overdue', 'cancelled'], default: 'upcoming' },
  paid_date: { type: 'date' },
  payment_card_id: { type: 'int', min: 1 },
  category: { type: 'text', max: 60 },
  receipt_file: { type: 'text', max: 400 },
  notes: { type: 'text', max: 4000 },
};

// Card numbers: the brief is strict, so anything that is not exactly 4 digits is refused
// before it reaches the database (which refuses it too).
function cleanCard(body, opts) {
  if (body && body.last4 !== undefined) {
    const digits = String(body.last4).replace(/\s/g, '');
    if (!/^\d{4}$/.test(digits)) {
      throw new HttpError(400, 'last4 must be exactly the last 4 digits; never enter a full card number, CVV or PIN',
        { last4: 'exactly 4 digits' });
    }
    body = { ...body, last4: digits };
  }
  for (const k of ['pan', 'card_number', 'number', 'cvv', 'cvc', 'pin']) {
    if (body && body[k] !== undefined) throw new HttpError(400, `field "${k}" is not accepted: only the last 4 digits are stored`);
  }
  return clean(CARD_FIELDS, body, opts);
}

function cleanBill(body, opts) {
  const row = clean(BILL_FIELDS, body, opts);
  if (row.payment_card_id && !db.get('SELECT id FROM cards WHERE id = ?', row.payment_card_id)) {
    throw new HttpError(400, 'payment_card_id does not exist', { payment_card_id: 'unknown card' });
  }
  if (row.receipt_file) assertRelative(row.receipt_file);
  return row;
}

function assertRelative(p) {
  if (p.startsWith('/') || p.split(/[\\/]/).includes('..')) throw new HttpError(400, 'receipt_file must be a path inside the receipts folder');
}

// Fills the computed columns from due_date + cycle.
function withSchedule(row, existing = {}) {
  const merged = { ...existing, ...row };
  const out = { ...row };
  if (row.due_date) out.anchor_day = D.parse(row.due_date).d;
  out.next_due_date = D.nextOccurrence(merged.due_date, merged.billing_cycle, out.anchor_day ?? merged.anchor_day);
  return out;
}

function createBill(body) {
  const row = withSchedule(cleanBill(body));
  return db.insert('bills', row);
}

function updateBill(id, body) {
  const existing = mustGet('bills', id);
  // the amount is parsed in the bill's currency, so keep the stored one when the body omits it
  const row = withSchedule(cleanBill({ currency: existing.currency, ...body }, { partial: true }), existing);
  db.update('bills', id, row);
}

function mustGet(table, id) {
  const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
  if (!row) throw new HttpError(404, `${table.replace(/s$/, '')} ${id} not found`);
  return row;
}

// Logs the payment; recurring bills roll forward to their next occurrence and become
// 'upcoming' again, one-time bills become 'paid'.
function markPaid(id, { paid_date, amount, card_id, receipt_file, note } = {}) {
  return db.tx(() => {
    const bill = mustGet('bills', id);
    if (bill.status === 'cancelled') throw new HttpError(409, 'bill is cancelled');
    if (bill.status === 'paid') throw new HttpError(409, 'bill is already paid');
    const p = clean({
      paid_date: { type: 'date', required: true },
      amount: { type: 'money', min: 0 },
      card_id: { type: 'int', min: 1 },
      receipt_file: { type: 'text', max: 400 },
      note: { type: 'text', max: 1000 },
    }, { paid_date: paid_date || D.today(), amount, card_id, receipt_file, note, currency: bill.currency });
    if (p.receipt_file) assertRelative(p.receipt_file);
    const cardId = p.card_id || bill.payment_card_id;
    const card = cardId ? db.get('SELECT id, label, last4 FROM cards WHERE id = ?', cardId) : null;
    if (cardId && !card) throw new HttpError(400, 'unknown card');
    const paymentId = db.insert('payments_log', {
      bill_id: bill.id,
      paid_date: p.paid_date,
      period_due_date: bill.due_date,
      amount: p.amount ?? bill.amount,
      currency: bill.currency,
      card_id: card?.id ?? null,
      card_label: card ? `${card.label} ••${card.last4}` : null,
      receipt_file: p.receipt_file,
      note: p.note,
    });
    const next = D.nextOccurrence(bill.due_date, bill.billing_cycle, bill.anchor_day);
    if (next) {
      db.update('bills', bill.id, {
        status: 'upcoming',
        paid_date: p.paid_date,
        due_date: next,
        next_due_date: D.nextOccurrence(next, bill.billing_cycle, bill.anchor_day),
        receipt_file: null,
      });
    } else {
      db.update('bills', bill.id, { status: 'paid', paid_date: p.paid_date, next_due_date: null, receipt_file: p.receipt_file ?? bill.receipt_file });
    }
    return paymentId;
  });
}

// Month-end housekeeping: recompute next_due_date and flag overdue bills. Returns what changed.
function recompute({ today = D.today(), dryRun = false } = {}) {
  const changes = [];
  for (const b of db.all("SELECT * FROM bills WHERE status IN ('upcoming','overdue')")) {
    const next = D.nextOccurrence(b.due_date, b.billing_cycle, b.anchor_day);
    const status = b.due_date < today ? 'overdue' : 'upcoming';
    if (next !== b.next_due_date || status !== b.status) {
      changes.push({ id: b.id, vendor: b.vendor, from: b.status, to: status, next_due_date: next });
      if (!dryRun) db.update('bills', b.id, { next_due_date: next, status });
    }
  }
  return changes;
}

const parseList = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

// Warnings for one bill joined with its card (columns card_* from billsWithCards()).
function billWarnings(b, today = D.today()) {
  const w = [];
  if (b.status === 'cancelled' || b.status === 'paid') return w;
  if (amountDue(b).amount === null) w.push({ level: 'info', text: 'amount unknown' });
  if (!b.payment_card_id) {
    w.push({ level: 'warn', text: 'no card assigned' });
  } else {
    if (b.card_status && b.card_status !== 'active') w.push({ level: 'danger', text: `card ${b.card_label} is ${b.card_status}` });
    if (b.card_expiry_year && b.card_expiry_month) {
      const lastDay = D.monthEnd(D.ymd(b.card_expiry_year, b.card_expiry_month, 1));
      if (lastDay < b.due_date) w.push({ level: 'danger', text: `card ${b.card_label} expires before the due date` });
    }
    const countries = parseList(b.card_countries);
    if (b.receiver_country && !countries.includes('worldwide') && !countries.includes(b.receiver_country)) {
      w.push({ level: 'danger', text: `card ${b.card_label} is not usable in ${b.receiver_country}` });
    }
  }
  if (b.due_date < today) w.push({ level: 'danger', text: 'overdue' });
  return w;
}

// Amount to pay for the open occurrence: the bill's own amount, else what the last payment
// (from the old invoice) cost. `estimated` tells the UI the second case.
function amountDue(b) {
  if (b.amount !== null && b.amount !== undefined) return { amount: b.amount, estimated: false };
  if (b.last_paid_amount !== null && b.last_paid_amount !== undefined) return { amount: b.last_paid_amount, estimated: true };
  return { amount: null, estimated: false };
}

function billsWithCards(where = '1=1', ...params) {
  return db.all(`
    SELECT b.*, c.label AS card_label, c.last4 AS card_last4, c.status AS card_status,
           c.usable_countries AS card_countries, c.expiry_month AS card_expiry_month, c.expiry_year AS card_expiry_year,
           (SELECT p.amount FROM payments_log p WHERE p.bill_id = b.id AND p.amount IS NOT NULL
             ORDER BY p.paid_date DESC, p.id DESC LIMIT 1) AS last_paid_amount
    FROM bills b LEFT JOIN cards c ON c.id = b.payment_card_id
    WHERE ${where} ORDER BY b.due_date, b.vendor`, ...params);
}

module.exports = {
  cleanCard, cleanBill, createBill, updateBill, markPaid, recompute, billWarnings, billsWithCards, amountDue, mustGet, parseList,
};
