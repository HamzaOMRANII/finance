// npm run seed: first-run data. Safe to re-run: every block only inserts when its table is empty.
// Real issuer/client details are read from data/seed.local.json (gitignored); without it,
// placeholders are used so the repo never carries personal or bank data.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const inv = require('../lib/invoices');
const D = require('../../shared/dates.mjs');
const { toMinor } = require('../../shared/money.mjs');

db.open();
const today = D.today();
const localFile = path.join(config.ROOT, 'data', 'seed.local.json');
const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : null;
const log = (...a) => console.log('[seed]', ...a);

const PLACEHOLDER = {
  issuers: [
    { prefix: 'HO', legal_name: 'Hamza Omrani', country: 'VN', default_currency: 'EUR', is_default: 1 },
    { prefix: 'HOLLC', legal_name: 'Hamza Omrani LLC', country: 'US', tax_id: null, default_currency: 'USD', is_default: 0 },
  ],
  clients: [{
    company_name: 'French client (TODO)', country: 'FR', currency: 'EUR', language: 'FR', payment_terms_days: 30,
    issuer_prefix: 'HO',
    schedule: { frequency: 'monthly', send_rule: 'last_business_day', mode: 'approve_first', currency: 'EUR', line_items: [] },
    legacy_invoices: [],
  }],
};
const data = local || PLACEHOLDER;
if (!local) log('data/seed.local.json not found: using placeholders');

if (!db.get('SELECT COUNT(*) AS n FROM settings').n) {
  // EUR value of one unit; edit on the Settings page.
  db.setSetting('fx_rates', { EUR: 1, USD: 0.86, TND: 0.29, VND: 0.000033, updated: today, source: 'manual seed, update me' });
  log('settings: fx_rates');
}

if (!db.get('SELECT COUNT(*) AS n FROM issuer_profiles').n) {
  for (const { counters = {}, ...issuer } of data.issuers) {
    const id = inv.saveIssuer(null, issuer);
    // Continue sequences after invoices already issued outside FinTrack ({ "2026-09": 1 }).
    for (const [period, n] of Object.entries(counters)) {
      db.run("INSERT INTO invoice_counters (issuer_profile_id, kind, period, last_number) VALUES (?, 'invoice', ?, ?)", id, period, n);
    }
    log(`issuer ${issuer.prefix}: ${issuer.legal_name}, numbers ${issuer.number_format || '{PREFIX}-{YYYY}-{NNNN}'}`);
  }
}

if (!db.get('SELECT COUNT(*) AS n FROM clients').n) {
  for (const { schedule, legacy_invoices = [], issuer_prefix, ...client } of data.clients) {
    const issuer = db.get('SELECT id FROM issuer_profiles WHERE prefix = ?', issuer_prefix);
    const clientId = inv.saveClient(null, { ...client, default_issuer_profile_id: issuer.id });
    log(`client: ${client.company_name}`);
    if (schedule) {
      inv.saveSchedule(null, { ...schedule, client_id: clientId, issuer_profile_id: issuer.id });
      const s = db.get('SELECT next_run_date FROM recurring_invoice_schedules WHERE client_id = ?', clientId);
      log(`  schedule: ${schedule.mode}, ${schedule.send_rule}, next send ${s.next_run_date}`);
    }
    for (const l of legacy_invoices) {
      const totals = inv.computeTotals([{ description: l.description, quantity: 1, unit_price: toMinor(l.total, 'EUR') }], []);
      const row = db.get('SELECT * FROM clients WHERE id = ?', clientId);
      db.insert('outgoing_invoices', {
        invoice_number: l.number, client_id: clientId, issuer_profile_id: issuer.id,
        language: row.language, currency: row.currency,
        issue_date: l.issue_date, service_period_start: l.period[0], service_period_end: l.period[1],
        due_date: D.addDays(l.issue_date, row.payment_terms_days),
        line_items: JSON.stringify(totals.line_items), subtotal: totals.subtotal, tax_lines: '[]', tax_total: 0, total: totals.total,
        status: 'sent', sent_at: `${l.issue_date}T12:00:00.000Z`, sent_to: JSON.stringify({ manual: true, note: 'issued before FinTrack' }),
        pdf_path: l.file, is_legacy: 1, notes: 'Imported: issued before FinTrack. Mark as paid once the payment is confirmed.',
      });
      log(`  legacy invoice ${l.number} (${l.issue_date})`);
    }
  }
}

if (!db.get('SELECT COUNT(*) AS n FROM bills').n) {
  const nextOf = (day) => {
    let d = D.ymd(...[D.parse(today).y, D.parse(today).m], Math.min(day, 28));
    if (d < today) d = D.addMonths(d, 1, day);
    return d;
  };
  const bills = [
    { title: 'Dropbox Fax', vendor: 'Dropbox Fax', receiver_name: 'Dropbox, Inc.', receiver_country: 'US', currency: 'USD', billing_cycle: 'monthly', due_date: nextOf(1), category: 'Telecom', notes: 'TODO: amount and real due day' },
    { title: 'US phone number', vendor: 'Tello', receiver_name: 'Tello LLC', receiver_country: 'US', currency: 'USD', billing_cycle: 'monthly', due_date: nextOf(1), category: 'Telecom', notes: 'TODO: amount and real due day (receipt: tello.pdf)' },
    { title: 'Cloud VPS 4 + Auto Backup', vendor: 'Contabo', receiver_name: 'Contabo GmbH', receiver_country: 'DE', currency: 'EUR', billing_cycle: 'monthly', due_date: nextOf(14), category: 'Hosting', notes: 'TODO: amount (receipt: proforma_invoice.pdf)' },
    { title: 'Cloudflare', vendor: 'Cloudflare', receiver_name: 'Cloudflare, Inc.', receiver_country: 'US', currency: 'USD', billing_cycle: 'monthly', due_date: nextOf(1), category: 'Hosting', notes: 'TODO: amount, cycle and due day' },
    { title: 'Claude Pro', vendor: 'Anthropic', receiver_name: 'Anthropic Ireland, Limited', receiver_country: 'IE', currency: 'EUR', billing_cycle: 'monthly', due_date: nextOf(8), category: 'Software', notes: 'TODO: amount (receipt: Invoice-9BF0758D-8053862.pdf)' },
  ];
  const { createBill } = require('../lib/bills');
  for (const b of bills) createBill(b);
  log(`bills: ${bills.map((b) => b.vendor).join(', ')} (amounts TODO)`);
}

log('done');
