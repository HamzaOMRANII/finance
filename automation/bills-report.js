// A. Month-end bills report: recompute next_due_date, mark overdue bills, and email next
// month's bills (vendor, receiver, amount, date, card, warnings, totals per currency).
// Runs on the last day of the month (cron.sh guard; the script checks again unless --force).
const config = require('../src/server/config');
const { runJob } = require('./lib/job');
const bills = require('../src/server/lib/bills');
const { billOccurrences, fxRates } = require('../src/server/lib/dashboard');
const mailer = require('../src/server/lib/mailer');
const { link } = require('../src/server/lib/templates');
const D = require('../src/shared/dates.mjs');
const { formatMoney, toEurMinor } = require('../src/shared/money.mjs');

runJob('bills-report', async ({ today, dryRun, force, log }) => {
  if (!force && !D.isLastDayOfMonth(today)) {
    log(`not the last day of the month (${today}); use --force to run anyway`);
    return 'skipped: not month end';
  }

  const changes = bills.recompute({ today, dryRun });
  for (const c of changes) log(`${dryRun ? 'would update' : 'updated'} bill #${c.id} ${c.vendor}: ${c.from} -> ${c.to}, next ${c.next_due_date}`);

  const start = D.addMonths(D.monthStart(today), 1);
  const end = D.monthEnd(start);
  const rates = fxRates();
  const rows = [];
  for (const b of bills.billsWithCards()) {
    const occ = billOccurrences(b, start, end);
    // overdue bills are carried into the report too: they still have to be paid
    if (b.status !== 'cancelled' && b.status !== 'paid' && b.due_date < start && !occ.length) occ.push(b.due_date);
    for (const date of occ) rows.push({ ...b, amount: bills.amountDue(b).amount, date, warnings: bills.billWarnings({ ...b, due_date: date }, today) });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const totals = {};
  let unknown = 0;
  for (const r of rows) {
    if (r.amount === null) unknown++;
    else totals[r.currency] = (totals[r.currency] || 0) + r.amount;
  }
  let eur = 0;
  for (const [cur, minor] of Object.entries(totals)) eur += toEurMinor(minor, cur, rates) || 0;

  const monthTitle = `${D.monthName(D.parse(start).m)} ${D.parse(start).y}`;
  const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  const lines = [
    `Bills for ${monthTitle}`,
    '',
    `${pad('Date', 11)}${pad('Vendor', 18)}${pad('Receiver', 24)}${pad('Amount', 14)}Card`,
    '-'.repeat(86),
    ...rows.flatMap((r) => [
      `${pad(r.date, 11)}${pad(r.vendor, 18)}${pad(`${r.receiver_name || ''} ${r.receiver_country || ''}`, 23)} ${pad(r.amount === null ? 'TODO' : formatMoney(r.amount, r.currency), 14)}${r.card_label ? `${r.card_label} ••${r.card_last4}` : '— no card —'}`,
      ...r.warnings.filter((w) => w.level !== 'info').map((w) => `${' '.repeat(11)}! ${w.text}`),
    ]),
    '-'.repeat(86),
    `Totals: ${Object.entries(totals).map(([c, m]) => formatMoney(m, c)).join(' · ') || '—'}`,
    `≈ ${formatMoney(eur, 'EUR')} at the rates in Settings (${rates.updated || 'no date'})`,
    unknown ? `${unknown} bill(s) have no amount yet.` : '',
    changes.length ? `\nHousekeeping: ${changes.length} bill(s) updated (overdue / next due date).` : '',
    '',
    `Open FinTrack: ${link('/bills')}`,
  ].filter((l) => l !== '');
  const text = lines.join('\n');
  log(text);

  if (dryRun) {
    log(`[dry-run] would email this report to ${config.ownerEmail}`);
  } else {
    const out = await mailer.notifyOwner({ kind: 'bills-report', dedupeKey: `bills-report:${start.slice(0, 7)}`, subject: `FinTrack · bills for ${monthTitle}: ${formatMoney(eur, 'EUR')}`, text });
    log(out.skipped ? `email skipped: ${out.skipped}` : `emailed to ${config.ownerEmail}`);
  }
  return `${rows.length} bill(s) for ${monthTitle}, ${changes.length} updated`;
});
