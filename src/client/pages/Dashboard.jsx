import { useState } from 'react';
import { useApi, money, moneyMap, shortDate, go, today } from '../lib.js';
import { PageHead, Badge, Money, Flag, Days, Empty, Loading } from '../ui.jsx';
import { addMonths, monthStart, parse, daysInMonth, weekday, ymd } from '../../shared/dates.mjs';

const eur = (minor) => money(minor, 'EUR');

export default function Dashboard() {
  const [d, reload, error] = useApi('/dashboard');
  if (error && !d) return <div className="form-error">{error.message}</div>;
  if (!d) return <Loading />;
  const k = d.kpis;
  const nm = new Date(`${d.next_month.start}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const missing = [...new Set([...k.bills_next_month.missing_rates, ...k.income_next_month.missing_rates])];

  return (
    <>
      <PageHead title="Dashboard" lead={`Today is ${shortDate(d.today)} (Africa/Lagos). Next month: ${nm}.`}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={reload}>Refresh</button>
      </PageHead>

      <div className="kpis">
        <Kpi label={`To pay in ${nm}`} value={eur(k.bills_next_month.eur)} sub={moneyMap(k.bills_next_month.by_currency)}
          extra={k.bills_next_month.unknown_amounts ? `${k.bills_next_month.unknown_amounts} bill(s) without amount` : null} tone="accent" />
        <Kpi label="Upcoming bills" value={k.upcoming_bills} sub="next 60 days" />
        <Kpi label="Overdue bills" value={k.overdue_bills} tone={k.overdue_bills ? 'bad' : 'ok'} />
        <Kpi label={`Expected income ${nm}`} value={eur(k.income_next_month.eur)} sub={moneyMap(k.income_next_month.by_currency)} tone="ok" />
        <Kpi label="Unpaid client invoices" value={eur(k.unpaid_invoices.eur)} sub={`${k.unpaid_invoices.count} open · ${moneyMap(k.unpaid_invoices.by_currency)}`} />
        <Kpi label="Overdue receivables" value={eur(k.overdue_receivables.eur)} sub={`${k.overdue_receivables.count} invoice(s)`} tone={k.overdue_receivables.count ? 'bad' : 'ok'} />
        <Kpi label="Net projection" value={eur(k.net_projection_eur)} sub={`income − bills, ${nm}`} tone={k.net_projection_eur < 0 ? 'bad' : 'ok'} />
      </div>
      {missing.length > 0 && <div className="note">No exchange rate for {missing.join(', ')}: those amounts are left out of the EUR totals. Set rates in Settings.</div>}

      {d.warnings.length > 0 && (
        <section className="panel">
          <div className="panel-title"><h2>Warnings</h2><span className="hint">{d.warnings.length}</span></div>
          <div className="warnings">
            {d.warnings.map((w, i) => (
              <a key={i} className={`warning ${w.level}`} href={w.link} onClick={go(w.link)}>
                <span className="dot" />{w.text}
              </a>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="panel-title"><h2>Upcoming bills</h2><a className="hint" href="/bills" onClick={go('/bills')}>All bills →</a></div>
        {d.upcoming_bills.length ? (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Vendor</th><th>Receiver</th><th className="num">Amount</th><th>Due</th><th>Left</th><th>Card</th><th>Status</th></tr></thead>
              <tbody>
                {d.upcoming_bills.map((b) => {
                  const danger = b.warnings.some((w) => w.level === 'danger');
                  const tone = b.days_left < 0 || danger ? 'row-danger' : b.days_left <= 7 || b.warnings.some((w) => w.level === 'warn') ? 'row-warn' : 'row-ok';
                  return (
                    <tr key={b.id} className={`clickable ${tone}`} onClick={go(`/bills?id=${b.id}`)}>
                      <td><div className="cell-title">{b.vendor}</div><div className="cell-sub">{b.title}</div></td>
                      <td>{b.receiver_name} <Flag code={b.receiver_country} /></td>
                      <td className="num"><Money minor={b.amount} currency={b.currency} /></td>
                      <td className="mono">{shortDate(b.due_date)}</td>
                      <td><Days n={b.days_left} /></td>
                      <td>{b.card ? <span className="mono">{b.card.label} ••{b.card.last4}</span> : <span className="muted">—</span>}</td>
                      <td><Badge status={b.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="panel"><Empty>No bills due in the next 60 days.</Empty></div>}
      </section>

      <section>
        <div className="panel-title"><h2>Outgoing invoices</h2><a className="hint" href="/schedules" onClick={go('/schedules')}>Schedules →</a></div>
        {d.outgoing.length ? (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Client</th><th>Status</th><th>Draft on</th><th>Send on</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {d.outgoing.map((o, i) => {
                  const link = o.id ? `/invoices/${o.id}` : '/schedules';
                  return (
                    <tr key={i} className={`clickable ${o.status === 'pending_approval' ? 'row-warn' : ''}`} onClick={go(link)}>
                      <td className="cell-title">{o.client}</td>
                      <td><Badge status={o.status}>{o.status === 'scheduled' ? `scheduled · ${o.mode.replace('_', ' ')}` : null}</Badge></td>
                      <td className="mono">{o.draft_date ? shortDate(o.draft_date) : '—'}</td>
                      <td className="mono">{shortDate(o.send_date)}</td>
                      <td className="num">{money(o.total, o.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="panel"><Empty>No client invoices planned.</Empty></div>}
      </section>

      <Calendar />
    </>
  );
}

function Kpi({ label, value, sub, extra, tone }) {
  return (
    <div className={`kpi ${tone || ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {extra && <div className="kpi-sub" style={{ color: 'var(--gold)' }}>{extra}</div>}
    </div>
  );
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Calendar() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [data] = useApi(`/calendar?month=${month}`);
  const first = `${month}-01`;
  const { y, m } = parse(first);
  const lead = (weekday(first) + 6) % 7; // Monday first
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth(y, m); d++) cells.push(ymd(y, m, d));
  while (cells.length % 7) cells.push(null);
  const byDate = {};
  for (const e of data?.events || []) (byDate[e.date] ||= []).push(e);
  const shift = (n) => setMonth(addMonths(monthStart(first), n).slice(0, 7));
  const t = today();
  const title = new Date(`${first}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <section className="panel">
      <div className="panel-title">
        <div className="cal-head">
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
        <div className="legend">
          <span><i className="ev-bill" />bill due</span>
          <span><i className="ev-invoice_draft" />invoice draft</span>
          <span><i className="ev-invoice_send" />invoice send</span>
          <span><i className="ev-invoice_due" />invoice due</span>
        </div>
      </div>
      <div className="cal">
        {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="cal-day other" />;
          const wd = weekday(date);
          return (
            <div key={date} className={`cal-day${date === t ? ' today' : ''}${wd === 0 || wd === 6 ? ' weekend' : ''}`}>
              <div className="cal-num">{parse(date).d}</div>
              {(byDate[date] || []).map((e, j) => (
                <a key={j} href={e.link} onClick={go(e.link)} className={`cal-ev ev-${e.kind}${e.warn ? ' warn' : ''}`}
                  title={`${e.title}${e.amount != null ? ` · ${money(e.amount, e.currency)}` : ''}`}>
                  {e.title}
                </a>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
