import { useState } from 'react';
import { api, useApi, decimal, shortDate, navigate, today, money, moneyMap } from '../lib.js';
import {
  PageHead, Badge, Money, Flag, Days, Empty, Loading, Modal, Field, Input, Select, Textarea, FormError, useForm, useToast, ConfirmButton,
} from '../ui.jsx';
import { CURRENCIES } from '../../shared/money.mjs';

const CYCLES = ['one-time', 'monthly', 'quarterly', 'yearly'];
const STATUSES = ['upcoming', 'paid', 'overdue', 'cancelled'];

export default function Bills({ query }) {
  const [filters, setFilters] = useState({ q: '', status: '', card: '', currency: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const [bills, reload] = useApi(`/bills${qs ? `?${qs}` : ''}`);
  const [cards] = useApi('/cards');
  const [editing, setEditing] = useState(null); // bill object or {} for new
  const [paying, setPaying] = useState(null);
  const openId = query.get('id');
  const close = () => { setEditing(null); if (openId) navigate('/bills'); };
  const current = editing || (openId && bills?.find((b) => String(b.id) === openId));
  const f = (k) => (e) => setFilters((s) => ({ ...s, [k]: e.target.value }));

  return (
    <>
      <PageHead title="Bills" lead="Everything I pay: subscriptions, hosting, phone numbers. Paying a recurring bill logs the payment and rolls it to its next due date.">
        <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>+ New bill</button>
      </PageHead>

      <div className="filters">
        <input className="input" placeholder="Search vendor, title…" value={filters.q} onChange={f('q')} />
        <select className="select" value={filters.status} onChange={f('status')}>
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="select" value={filters.card} onChange={f('card')}>
          <option value="">All cards</option>{(cards || []).map((c) => <option key={c.id} value={c.id}>{c.label} ••{c.last4}</option>)}
        </select>
        <select className="select" value={filters.currency} onChange={f('currency')}>
          <option value="">All currencies</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      {!bills ? <Loading /> : bills.length === 0 ? <div className="panel"><Empty>No bills match.</Empty></div> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Vendor</th><th>Receiver</th><th className="num">Amount</th><th>Cycle</th><th>Due</th><th>Left</th><th>Card</th><th>Status</th><th /></tr></thead>
            <tbody>
              {bills.map((b) => {
                const danger = b.warnings.some((w) => w.level === 'danger');
                const tone = ['paid', 'cancelled'].includes(b.status) ? '' : danger ? 'row-danger' : b.warnings.some((w) => w.level === 'warn') ? 'row-warn' : 'row-ok';
                return (
                  <tr key={b.id} className={`clickable ${tone}`} onClick={() => setEditing(b)}>
                    <td><div className="cell-title">{b.vendor}</div><div className="cell-sub">{b.title}{b.category ? ` · ${b.category}` : ''}</div></td>
                    <td>{b.receiver_name} <Flag code={b.receiver_country} /></td>
                    <td className="num"><AmountDue bill={b} /></td>
                    <td className="muted">{b.billing_cycle}</td>
                    <td className="mono">{shortDate(b.due_date)}</td>
                    <td>{!['paid', 'cancelled'].includes(b.status) && <Days n={b.days_left} />}</td>
                    <td>{b.card_label ? <span className="mono">{b.card_label} ••{b.card_last4}</span> : <span className="muted">—</span>}</td>
                    <td><Badge status={b.status} /></td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      {['upcoming', 'overdue'].includes(b.status) && <button type="button" className="btn btn-gold btn-sm" onClick={() => setPaying(b)}>Mark paid</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <BillsTotal bills={bills} cols={9} />
          </table>
        </div>
      )}

      {current && <BillModal bill={current} cards={cards || []} onClose={close} onSaved={() => { close(); reload(); }} onPay={(b) => { close(); setPaying(b); }} />}
      {paying && <PayModal bill={paying} cards={cards || []} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); reload(); }} />}
    </>
  );
}

// Amount to pay for the open occurrence; "last paid" when it comes from the previous payment,
// "≈ €" when the bill is in another currency.
export function AmountDue({ bill: b }) {
  const minor = b.amount_due !== undefined ? b.amount_due : b.amount;
  return (
    <>
      <Money minor={minor} currency={b.currency} />
      {b.amount_estimated && <div className="cell-sub">last paid</div>}
      {minor !== null && b.currency !== 'EUR' && (b.amount_due_eur ?? b.amount_eur) != null && <div className="cell-sub">≈ {money(b.amount_due_eur ?? b.amount_eur, 'EUR')}</div>}
    </>
  );
}

// Footer: total still to pay for the open bills in the table (paid/cancelled ones left out).
function BillsTotal({ bills, cols }) {
  const open = bills.filter((b) => !['paid', 'cancelled'].includes(b.status));
  if (!open.length) return null;
  const byCur = {};
  let eur = 0;
  let unknown = 0;
  let noRate = false;
  for (const b of open) {
    if (b.amount_due === null) { unknown++; continue; }
    byCur[b.currency] = (byCur[b.currency] || 0) + b.amount_due;
    if (b.amount_due_eur === null) noRate = true; else eur += b.amount_due_eur;
  }
  return (
    <tfoot>
      <tr className="total-row">
        <td colSpan={2}>To pay ({open.length} open bill{open.length > 1 ? 's' : ''})</td>
        <td className="num"><div className="cell-title">{money(eur, 'EUR')}{noRate ? '*' : ''}</div><div className="cell-sub">{moneyMap(byCur)}</div></td>
        <td colSpan={cols - 3} className="muted">{unknown ? `${unknown} without amount (not counted)` : ''}</td>
      </tr>
    </tfoot>
  );
}

// Used by Bills and by the Receipts import (with `prefill`).
export function BillModal({ bill, cards, onClose, onSaved, onPay, prefill, title }) {
  const toast = useToast();
  const isNew = !bill.id;
  const [receipts] = useApi('/receipts');
  const [detail] = useApi(bill.id ? `/bills/${bill.id}` : null);
  const form = useForm({
    title: bill.title || '', vendor: bill.vendor || '', receiver_name: bill.receiver_name || '', receiver_country: bill.receiver_country || '',
    amount: decimal(bill.amount, bill.currency || 'EUR'), currency: bill.currency || 'EUR', billing_cycle: bill.billing_cycle || 'monthly',
    due_date: bill.due_date || today(), status: bill.status || 'upcoming', payment_card_id: bill.payment_card_id || '',
    category: bill.category || '', receipt_file: bill.receipt_file || '', notes: bill.notes || '', ...prefill,
  });
  const save = () => form.submit(async (v) => {
    if (isNew) await api('/bills', { method: 'POST', body: v });
    else await api(`/bills/${bill.id}`, { method: 'PUT', body: v });
    toast(isNew ? 'Bill created' : 'Bill saved');
    onSaved();
  });
  const remove = () => form.submit(async () => {
    await api(`/bills/${bill.id}`, { method: 'DELETE' });
    toast('Bill deleted');
    onSaved();
  });
  const warnings = detail?.warnings || [];
  const fv = form.values;
  const [reading, setReading] = useState(false);
  // Reads the amount (and currency) from the selected receipt / old invoice.
  const readReceipt = async () => {
    setReading(true);
    try {
      const r = await api('/receipts/extract', { method: 'POST', body: { path: fv.receipt_file } });
      const { amount, currency } = r.fields || {};
      if (amount === null || amount === undefined) toast(r.note || 'No amount found in this receipt: type it in', 'bad');
      else {
        const cur = currency || fv.currency;
        form.setValues((v) => ({ ...v, amount: decimal(amount, cur), currency: cur }));
        toast(`Amount read from the receipt: ${money(amount, cur)}`);
      }
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setReading(false);
    }
  };
  const lastPaid = detail?.payments?.find((p) => p.amount !== null);

  return (
    <Modal title={title || (isNew ? 'New bill' : `${bill.vendor}: ${bill.title}`)} onClose={onClose} wide={!!fv.receipt_file}
      footer={<>
        {!isNew && <ConfirmButton className="btn btn-danger" confirm="Delete this bill and its payment history?" onConfirm={remove}>Delete</ConfirmButton>}
        <span className="spacer" />
        {!isNew && onPay && ['upcoming', 'overdue'].includes(bill.status) && <button type="button" className="btn btn-gold" onClick={() => onPay(bill)}>Mark paid…</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={form.busy}>{isNew ? 'Create bill' : 'Save'}</button>
      </>}>
      <div className={fv.receipt_file ? 'split' : undefined}>
        <div className="stack">
          <FormError form={form} />
          {warnings.filter((w) => w.level !== 'info').map((w, i) => <div key={i} className="note">{w.text}</div>)}
          <div className="form">
            <Field label="Vendor" error={form.errors.vendor}><Input form={form} name="vendor" required /></Field>
            <Field label="Title" error={form.errors.title}><Input form={form} name="title" required /></Field>
            <Field label="Receiver" help="company or person paid"><Input form={form} name="receiver_name" /></Field>
            <Field label="Receiver country" help="ISO-2, e.g. US" error={form.errors.receiver_country}><Input form={form} name="receiver_country" maxLength={2} style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="Amount to pay" help={lastPaid ? `empty = last paid (${money(lastPaid.amount, lastPaid.currency)})` : 'empty = unknown; read from the receipt below'} error={form.errors.amount}>
              <Input form={form} name="amount" inputMode="decimal" mono />
            </Field>
            <Field label="Currency"><Select form={form} name="currency" options={CURRENCIES} /></Field>
            <Field label="Billing cycle"><Select form={form} name="billing_cycle" options={CYCLES} /></Field>
            <Field label="Due date" help="open occurrence" error={form.errors.due_date}><Input form={form} name="due_date" type="date" /></Field>
            <Field label="Card"><Select form={form} name="payment_card_id" empty="— no card —" options={cards.map((c) => [c.id, `${c.label} ••${c.last4} (${c.status})`])} /></Field>
            <Field label="Status"><Select form={form} name="status" options={STATUSES} /></Field>
            <Field label="Category"><Input form={form} name="category" /></Field>
            <Field label="Receipt" help="from the receipts folder">
              <Select form={form} name="receipt_file" empty="— none —" options={(receipts || []).map((r) => [r.path, r.path])} />
              {fv.receipt_file && <button type="button" className="btn btn-ghost btn-sm" onClick={readReceipt} disabled={reading}>{reading ? 'Reading…' : 'Use amount from receipt'}</button>}
            </Field>
            <Field label="Notes" full><Textarea form={form} name="notes" /></Field>
          </div>
          {detail?.payments?.length > 0 && (
            <div>
              <div className="panel-title"><h2>Payments</h2></div>
              <div className="table-wrap">
                <table className="t">
                  <thead><tr><th>Paid</th><th>For due date</th><th className="num">Amount</th><th>Card</th></tr></thead>
                  <tbody>{detail.payments.map((p) => (
                    <tr key={p.id}><td className="mono">{shortDate(p.paid_date)}</td><td className="mono">{shortDate(p.period_due_date)}</td>
                      <td className="num"><Money minor={p.amount} currency={p.currency} /></td><td className="mono">{p.card_label || '—'}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        {fv.receipt_file && <ReceiptPreview path={fv.receipt_file} />}
      </div>
    </Modal>
  );
}

export function ReceiptPreview({ path }) {
  const url = `/api/receipts/file?path=${encodeURIComponent(path)}`;
  return /\.pdf$/i.test(path)
    ? <iframe className="receipt-frame" src={url} title={`Receipt ${path}`} />
    : <img className="receipt-img" src={url} alt={`Receipt ${path}`} />;
}

function PayModal({ bill, cards, onClose, onPaid }) {
  const toast = useToast();
  const [receipts] = useApi('/receipts');
  const form = useForm({ paid_date: today(), amount: decimal(bill.amount, bill.currency), card_id: bill.payment_card_id || '', receipt_file: '', note: '' });
  const pay = () => form.submit(async (v) => {
    await api(`/bills/${bill.id}/pay`, { method: 'POST', body: v });
    toast(bill.billing_cycle === 'one-time' ? 'Marked as paid' : 'Payment logged; bill moved to its next due date');
    onPaid();
  });
  return (
    <Modal title={`Mark paid: ${bill.vendor}`} onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-gold" onClick={pay} disabled={form.busy}>Log payment</button></>}>
      <div className="stack">
        <div className="note info">Due {shortDate(bill.due_date)}{bill.amount != null ? ` · ${money(bill.amount, bill.currency)}` : ''}{bill.billing_cycle !== 'one-time' ? ` · then next due on the following ${bill.billing_cycle} date` : ''}</div>
        <FormError form={form} />
        <div className="form">
          <Field label="Paid on"><Input form={form} name="paid_date" type="date" /></Field>
          <Field label={`Amount (${bill.currency})`} error={form.errors.amount}><Input form={form} name="amount" inputMode="decimal" mono /></Field>
          <Field label="Card used"><Select form={form} name="card_id" empty="— none —" options={cards.map((c) => [c.id, `${c.label} ••${c.last4}`])} /></Field>
          <Field label="Receipt"><Select form={form} name="receipt_file" empty="— none —" options={(receipts || []).map((r) => [r.path, r.path])} /></Field>
          <Field label="Note" full><Input form={form} name="note" /></Field>
        </div>
      </div>
    </Modal>
  );
}
