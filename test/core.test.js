// npm test: money, dates and the invoice rules that must never regress.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-test-'));
process.env.DB_FILE = path.join(tmp, 't.db');
process.env.ISSUED_DIR = path.join(tmp, 'issued');

const { toMinor, formatMoney } = require('../src/shared/money.mjs');
const D = require('../src/shared/dates.mjs');
const db = require('../src/server/db');
const bills = require('../src/server/lib/bills');
const inv = require('../src/server/lib/invoices');

test('money parsing', () => {
  assert.equal(toMinor('1 627,50', 'EUR'), 162750);
  assert.equal(toMinor('1,627.50', 'USD'), 162750);
  assert.equal(toMinor('12.345', 'TND'), 12345);
  assert.equal(toMinor('250000', 'VND'), 250000);
  assert.ok(Number.isNaN(toMinor('abc', 'EUR')));
  assert.equal(formatMoney(162700, 'EUR', 'FR'), '1 627,00 €');
});

test('dates: last business day and month clamping', () => {
  assert.equal(D.lastBusinessDay('2026-10-05'), '2026-10-30'); // Oct 31 2026 is a Saturday
  assert.equal(D.lastBusinessDay('2026-05-01'), '2026-05-29'); // May 31 Sunday, 30 Saturday
  assert.equal(D.addMonths('2026-01-31', 1, 31), '2026-02-28');
  assert.equal(D.addMonths('2026-02-28', 1, 31), '2026-03-31');
});

test('cards accept only 4 digits', () => {
  db.open();
  assert.throws(() => bills.cleanCard({ label: 'x', last4: '12345' }), /exactly the last 4 digits/);
  assert.throws(() => bills.cleanCard({ label: 'x', last4: '1234', cvv: '123' }), /not accepted/);
  assert.throws(() => db.insert('cards', { label: 'x', last4: '4111111111111111' }), /CHECK/);
});

test('numbering is gapless, sent invoices are frozen', async () => {
  const issuer = inv.saveIssuer(null, { prefix: 'TT', legal_name: 'Test', is_default: 1 });
  const client = inv.saveClient(null, { company_name: 'Client', language: 'EN', payment_terms_days: 30 });
  const a = inv.createInvoice({ client_id: client, issuer_profile_id: issuer, line_items: [{ description: 'A', quantity: 2, unit_price: '100' }] });
  const b = inv.createInvoice({ client_id: client, issuer_profile_id: issuer, line_items: [{ description: 'B', quantity: 1, unit_price: '50' }] });
  inv.deleteDraft(a); // drafts have no number: deleting one leaves no gap
  const sent = await inv.markSent(b, { today: '2026-11-02' });
  assert.equal(sent.invoice_number, 'TT-2026-0001');
  assert.equal(sent.due_date, '2026-12-02');
  assert.throws(() => db.run('UPDATE outgoing_invoices SET total = 1 WHERE id = ?', b), /immutable/);
  assert.throws(() => db.run('DELETE FROM outgoing_invoices WHERE id = ?', b), /cannot be deleted/);
  const c = inv.createInvoice({ client_id: client, issuer_profile_id: issuer, line_items: [{ description: 'C', quantity: 1, unit_price: '10' }] });
  assert.equal((await inv.markSent(c, { today: '2026-11-03' })).invoice_number, 'TT-2026-0002');
});

test('schedule drafts are idempotent per period', () => {
  const client = db.get('SELECT id FROM clients').id;
  const issuer = db.get('SELECT id FROM issuer_profiles').id;
  const id = inv.saveSchedule(null, { client_id: client, issuer_profile_id: issuer, line_items: [{ description: 'Work {Month} {year}', quantity: 1, unit_price: '1000' }] });
  const s = db.get('SELECT * FROM recurring_invoice_schedules WHERE id = ?', id);
  const first = inv.draftFromSchedule(s, '2026-10-30');
  const again = inv.draftFromSchedule(s, '2026-10-30');
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(JSON.parse(first.invoice.line_items)[0].description, 'Work October 2026');
  assert.equal(db.get('SELECT next_run_date FROM recurring_invoice_schedules WHERE id = ?', id).next_run_date, '2026-11-30');
});

test('monthly number format continues after imported numbers', async () => {
  const issuer = inv.saveIssuer(null, { prefix: 'MM', legal_name: 'Monthly', number_format: 'INV-{YYYY}-{MM}-{NNN}' });
  assert.throws(() => inv.saveIssuer(null, { prefix: 'BAD', legal_name: 'x', number_format: 'INV-{YYYY}' }), /sequence token/);
  const client = db.get('SELECT id FROM clients').id;
  db.insert('outgoing_invoices', { invoice_number: 'INV-2026-10-001', client_id: client, issuer_profile_id: issuer, language: 'FR', currency: 'EUR', status: 'sent', sent_at: 'x', is_legacy: 1 });
  const mk = () => inv.createInvoice({ client_id: client, issuer_profile_id: issuer, line_items: [{ description: 'x', quantity: 1, unit_price: '1' }] });
  assert.equal(inv.peekNumber(issuer, '2026-10-30'), 'INV-2026-10-002');
  assert.equal((await inv.markSent(mk(), { today: '2026-10-30' })).invoice_number, 'INV-2026-10-002');
  assert.equal((await inv.markSent(mk(), { today: '2026-11-02' })).invoice_number, 'INV-2026-11-001');
});

test('a draft keeps the reference and due date typed on it', async () => {
  const issuer = inv.saveIssuer(null, { prefix: 'RF', legal_name: 'Ref', number_format: 'INV-{YYYY}-{MM}-{NNN}' });
  const client = inv.saveClient(null, { company_name: 'Ref client', language: 'EN', payment_terms_days: 0 });
  const line = [{ description: 'x', quantity: 1, unit_price: '1' }];
  const a = inv.createInvoice({ client_id: client, issuer_profile_id: issuer, line_items: line, requested_number: 'INV-2026-09-007', due_date: '2026-11-15' });
  assert.equal(inv.draftNumber(db.get('SELECT * FROM outgoing_invoices WHERE id = ?', a)), 'INV-2026-09-007');
  // two drafts cannot ask for the same reference
  assert.throws(() => inv.createInvoice({ client_id: client, issuer_profile_id: issuer, line_items: line, requested_number: 'INV-2026-09-007' }), /already used/);
  const sent = await inv.markSent(a, { today: '2026-11-02' });
  assert.equal(sent.invoice_number, 'INV-2026-09-007');
  assert.equal(sent.due_date, '2026-11-15');
  // the automatic sequence is not disturbed, and a used number cannot be asked for again
  assert.equal(inv.peekNumber(issuer, '2026-12-01'), 'INV-2026-12-001');
  assert.throws(() => inv.createInvoice({ client_id: client, issuer_profile_id: issuer, line_items: line, requested_number: 'INV-2026-09-007' }), /already used/);
});

test('bill amount falls back to the last payment; dashboard money flows', () => {
  const dash = require('../src/server/lib/dashboard');
  const id = bills.createBill({ title: 'Plan', vendor: 'FlowCo', currency: 'EUR', billing_cycle: 'quarterly', due_date: '2026-10-20' });
  const row = () => bills.billsWithCards('b.id = ?', id)[0];
  assert.deepEqual(bills.amountDue(row()), { amount: null, estimated: false });
  bills.markPaid(id, { paid_date: '2026-10-05', amount: '30' });
  assert.deepEqual(bills.amountDue(row()), { amount: 3000, estimated: true });
  const k = dash.summary('2026-10-25').kpis;
  assert.ok(k.outcome_this_month.paid_eur >= 3000);
  assert.ok(k.recurring_monthly.by_currency.EUR >= 1000); // quarterly 30 -> 10 a month
  assert.equal(k.per_month.length, 12);
  assert.equal(k.per_month[11].month, '2026-10');
});
