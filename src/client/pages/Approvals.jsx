import { useState } from 'react';
import { api, useApi, money, shortDate, today, go } from '../lib.js';
import { PageHead, Badge, Empty, Loading, useToast } from '../ui.jsx';
import { LineItemsEditor, Totals, itemsToEdit } from './LineItems.jsx';

// The approval queue: drafts made by the daily job for approve_first schedules. Adjust the
// quantities (days worked), then approve (sent by the job on the send date) or send right away.
export default function Approvals() {
  const [rows, reload] = useApi('/approvals');
  return (
    <>
      <PageHead title="Approval queue" lead="Nothing in this list is emailed until you approve it. If a send date passes without approval, the invoice is not sent and you get a reminder every morning." />
      {!rows ? <Loading /> : rows.length === 0 ? <div className="panel"><Empty>Nothing waiting for approval.</Empty></div> : rows.map((o) => <Item key={`${o.id}-${o.updated_at}`} inv={o} onDone={reload} />)}
    </>
  );
}

function Item({ inv, onDone }) {
  const toast = useToast();
  const [items, setItems] = useState(itemsToEdit(inv.line_items, inv.currency));
  const [busy, setBusy] = useState(false);
  const late = inv.scheduled_send_date && inv.scheduled_send_date < today();
  const canSend = inv.billing_emails?.length > 0;
  const run = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      onDone();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const body = { client_id: inv.client_id, issuer_profile_id: inv.issuer_profile_id, line_items: items, tax_lines: inv.tax_lines };
  const approve = () => run(() => api(`/invoices/${inv.id}/approve`, { method: 'POST', body }), `Approved: it will be sent on ${shortDate(inv.scheduled_send_date)}`);
  const sendNow = () => {
    if (!window.confirm(`Number and email this invoice to ${inv.billing_emails.join(', ')} now?`)) return;
    run(async () => {
      if (inv.status !== 'approved') await api(`/invoices/${inv.id}/approve`, { method: 'POST', body });
      const out = await api(`/invoices/${inv.id}/send`, { method: 'POST', body: {} });
      if (out.skipped) throw new Error(out.skipped);
    }, 'Invoice sent');
  };
  return (
    <section className="panel stack">
      <div className="row">
        <h2 style={{ fontSize: 18 }}>{inv.company_name}</h2>
        <Badge status={inv.status} />
        {late && <Badge tone="b-bad">send date passed</Badge>}
        <span className="spacer" />
        <span className="mono muted">{inv.service_period_start && `${shortDate(inv.service_period_start)} – ${shortDate(inv.service_period_end)}`} · send {shortDate(inv.scheduled_send_date)}</span>
      </div>
      {!canSend && <div className="note">No billing email on this client: approve it, then open the invoice and use “Mark as sent” after delivering the PDF yourself.</div>}
      <LineItemsEditor items={items} onChange={setItems} currency={inv.currency} quantityOnly={inv.status === 'approved'} />
      <div className="row">
        <a className="btn btn-ghost btn-sm" href={`/invoices/${inv.id}`} onClick={go(`/invoices/${inv.id}`)}>Open full editor + preview</a>
        <span className="spacer" />
        <Totals items={items} taxes={inv.tax_lines || []} currency={inv.currency} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {inv.status !== 'approved' && <button type="button" className="btn btn-ghost" onClick={approve} disabled={busy}>Approve (send on {shortDate(inv.scheduled_send_date)})</button>}
        {inv.status === 'approved' && <span className="muted">Approved · goes out {shortDate(inv.scheduled_send_date)} 08:00</span>}
        <button type="button" className="btn btn-gold" onClick={sendNow} disabled={busy || !canSend}>Approve & send now · {money(inv.total, inv.currency)}</button>
      </div>
    </section>
  );
}
