import { useState } from 'react';
import { api, useApi, shortDate, go } from '../lib.js';
import {
  PageHead, Badge, Money, Flag, Empty, Loading, Modal, Field, Input, Select, Textarea, FormError, useForm, useToast, ConfirmButton,
} from '../ui.jsx';
import { CURRENCIES } from '../../shared/money.mjs';

const STATUSES = ['active', 'standby', 'blocked', 'expired'];
const NETWORKS = ['visa', 'mastercard', 'amex', 'unionpay', 'jcb', 'discover', 'other'];

export default function Cards() {
  const [cards, reload] = useApi('/cards');
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHead title="Cards" lead="Only a label and the last 4 digits are stored. Never type a full card number, CVV or PIN here.">
        <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>+ New card</button>
      </PageHead>
      {!cards ? <Loading /> : cards.length === 0 ? <div className="panel"><Empty>No cards yet.</Empty></div> : (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
          {cards.map((c) => <CardTile key={c.id} card={c} onOpen={() => setEditing(c)} />)}
        </div>
      )}
      {editing && <CardModal card={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function expiryText(c) {
  if (!c.expiry_month || !c.expiry_year) return '—/—';
  return `${String(c.expiry_month).padStart(2, '0')}/${String(c.expiry_year).slice(-2)}`;
}

function CardTile({ card, onOpen }) {
  return (
    <button type="button" className="panel" onClick={onOpen} style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row"><span className="cell-title">{card.label}</span><span className="spacer" /><Badge status={card.status} /></div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, letterSpacing: '.12em', color: '#fff' }}>•••• •••• •••• {card.last4}</div>
      <div className="row" style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
        <span>{card.bank || '—'}{card.network ? ` · ${card.network}` : ''}{card.swift ? ` · ${card.swift}` : ''}</span><span className="spacer" />
        <span className="mono">exp {expiryText(card)}</span>{card.currency && <span className="chip">{card.currency}</span>}
      </div>
      <div className="chips">{card.usable_countries.map((c) => <span key={c} className="chip"><Flag code={c} /> {c === 'worldwide' ? 'worldwide' : c}</span>)}</div>
      <div className="cell-sub">{card.bill_count} bill(s) on this card</div>
    </button>
  );
}

function CardModal({ card, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !card.id;
  const [detail] = useApi(card.id ? `/cards/${card.id}` : null);
  const form = useForm({
    label: card.label || '', bank: card.bank || '', network: card.network || '', last4: card.last4 || '',
    expiry_month: card.expiry_month || '', expiry_year: card.expiry_year || '', currency: card.currency || '',
    status: card.status || 'active', usable_countries: (card.usable_countries || ['worldwide']).join(', '), notes: card.notes || '',
    holder_name: card.holder_name || '', iban: card.iban || '', swift: card.swift || '', account_number: card.account_number || '',
    bank_country: card.bank_country || '', bank_address: card.bank_address || '',
  });
  const [showBank, setShowBank] = useState(!!(card.iban || card.swift || card.account_number || card.holder_name || card.bank_address));
  const save = () => form.submit(async (v) => {
    if (isNew) await api('/cards', { method: 'POST', body: v });
    else await api(`/cards/${card.id}`, { method: 'PUT', body: v });
    toast('Card saved');
    onSaved();
  });
  const remove = () => form.submit(async () => {
    await api(`/cards/${card.id}`, { method: 'DELETE' });
    toast('Card deleted; its bills now have no card');
    onSaved();
  });
  // Keep anything but digits out of the field, and never more than 4 of them.
  const onLast4 = (e) => form.set('last4')(e.target.value.replace(/\D/g, '').slice(0, 4));

  return (
    <Modal title={isNew ? 'New card' : card.label} onClose={onClose}
      footer={<>
        {!isNew && <ConfirmButton className="btn btn-danger" confirm="Delete this card? Bills using it will have no card." onConfirm={remove}>Delete</ConfirmButton>}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={form.busy}>Save</button>
      </>}>
      <div className="stack">
        <FormError form={form} />
        <div className="form">
          <Field label="Label" error={form.errors.label}><Input form={form} name="label" placeholder="Wise EUR debit" /></Field>
          <Field label="Last 4 digits" help="only these 4" error={form.errors.last4}>
            <input className="input mono" value={form.values.last4} onChange={onLast4} inputMode="numeric" maxLength={4} autoComplete="off" placeholder="1234" />
          </Field>
          <Field label="Bank"><Input form={form} name="bank" /></Field>
          <Field label="Network"><Select form={form} name="network" empty="—" options={NETWORKS} /></Field>
          <Field label="Expiry month" error={form.errors.expiry_month}><Input form={form} name="expiry_month" type="number" min="1" max="12" /></Field>
          <Field label="Expiry year" error={form.errors.expiry_year}><Input form={form} name="expiry_year" type="number" min="2020" max="2100" /></Field>
          <Field label="Currency"><Select form={form} name="currency" empty="—" options={CURRENCIES} /></Field>
          <Field label="Status"><Select form={form} name="status" options={STATUSES} /></Field>
          <Field label="Usable countries" help="ISO-2 codes, comma separated, or worldwide" full error={form.errors.usable_countries}>
            <Input form={form} name="usable_countries" placeholder="VN, CN, TN, FR, US, MY" />
          </Field>
          <Field label="Notes" full><Textarea form={form} name="notes" /></Field>
        </div>
        {!showBank
          ? <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowBank(true)}>+ Bank details (optional: SWIFT, IBAN…)</button></div>
          : (
            <div>
              <div className="panel-title"><h2>Bank details</h2><span className="hint">optional · for transfers to the account behind this card</span></div>
              <div className="form">
                <Field label="Account holder"><Input form={form} name="holder_name" /></Field>
                <Field label="SWIFT / BIC" help="8 or 11 characters" error={form.errors.swift}><Input form={form} name="swift" mono placeholder="VCBCVNVX" style={{ textTransform: 'uppercase' }} /></Field>
                <Field label="IBAN" error={form.errors.iban}><Input form={form} name="iban" mono placeholder="FR76 …" style={{ textTransform: 'uppercase' }} /></Field>
                <Field label="Account number" help="when there is no IBAN"><Input form={form} name="account_number" mono /></Field>
                <Field label="Bank country" help="ISO-2, e.g. VN" error={form.errors.bank_country}><Input form={form} name="bank_country" maxLength={2} style={{ textTransform: 'uppercase' }} /></Field>
                <Field label="Bank address" full><Input form={form} name="bank_address" /></Field>
              </div>
            </div>
          )}
        {detail?.bills?.length > 0 && (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Bill</th><th>Receiver</th><th className="num">Amount</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>{detail.bills.map((b) => (
                <tr key={b.id} className={`clickable ${b.warnings.some((w) => w.level === 'danger') ? 'row-danger' : ''}`} onClick={go(`/bills?id=${b.id}`)}>
                  <td className="cell-title">{b.vendor}</td><td><Flag code={b.receiver_country} /> {b.receiver_name}</td>
                  <td className="num"><Money minor={b.amount} currency={b.currency} /></td><td className="mono">{shortDate(b.due_date)}</td><td><Badge status={b.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
