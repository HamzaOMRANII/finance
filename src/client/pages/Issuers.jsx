import { useState } from 'react';
import { api, useApi } from '../lib.js';
import { PageHead, Badge, Flag, Empty, Loading, Modal, Field, Input, Select, Textarea, Check, FormError, useForm, useToast, ConfirmButton } from '../ui.jsx';
import { CURRENCIES } from '../../shared/money.mjs';

const FIELDS = ['prefix', 'legal_name', 'title_line', 'address', 'country', 'tax_id', 'email', 'phone', 'bank_beneficiary', 'bank_name', 'bank_iban',
  'bank_swift', 'bank_account', 'bank_address', 'bank_currency', 'bank_extra', 'payment_note', 'footer_text', 'default_currency', 'is_default'];

export default function Issuers() {
  const [rows, reload] = useApi('/issuers');
  const [editing, setEditing] = useState(null);
  return (
    <>
      <PageHead title="Issuer profiles" lead="Who an invoice is from. Each profile has its own gapless numbering: PREFIX-YYYY-####.">
        <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>+ New profile</button>
      </PageHead>
      {!rows ? <Loading /> : rows.length === 0 ? <div className="panel"><Empty>No issuer profiles.</Empty></div> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Legal name</th><th>Prefix</th><th>Country</th><th>Tax ID / EIN</th><th>Bank</th><th>Currency</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setEditing(r)}>
                <td><div className="cell-title">{r.legal_name}</div><div className="cell-sub">{r.title_line}</div></td>
                <td className="mono">{r.prefix}-YYYY-####</td>
                <td><Flag code={r.country} withName /></td>
                <td>{r.tax_id || <Badge tone="b-warn">pending</Badge>}</td>
                <td className="muted">{r.bank_name || '—'}</td>
                <td className="mono">{r.default_currency}</td>
                <td>{r.is_default ? <Badge tone="b-ok">default</Badge> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <IssuerModal issuer={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function IssuerModal({ issuer, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !issuer.id;
  const form = useForm(Object.fromEntries(FIELDS.map((k) => [k, issuer[k] ?? (k === 'default_currency' ? 'EUR' : k === 'is_default' ? false : '')])));
  const save = () => form.submit(async (v) => {
    if (isNew) await api('/issuers', { method: 'POST', body: v });
    else await api(`/issuers/${issuer.id}`, { method: 'PUT', body: v });
    toast('Profile saved');
    onSaved();
  });
  const remove = () => form.submit(async () => {
    await api(`/issuers/${issuer.id}`, { method: 'DELETE' });
    toast('Profile deleted');
    onSaved();
  });
  const e = form.errors;
  return (
    <Modal title={isNew ? 'New issuer profile' : issuer.legal_name} onClose={onClose} wide
      footer={<>
        {!isNew && <ConfirmButton className="btn btn-danger" confirm="Delete this profile?" onConfirm={remove}>Delete</ConfirmButton>}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={form.busy}>Save</button>
      </>}>
      <div className="stack">
        <FormError form={form} />
        <div className="form">
          <Field label="Legal name" error={e.legal_name}><Input form={form} name="legal_name" /></Field>
          <Field label="Number prefix" help="2–8 letters, frozen once used" error={e.prefix}><Input form={form} name="prefix" mono style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="Title line" help="under the name on the PDF" full><Input form={form} name="title_line" /></Field>
          <Field label="Address" full><Textarea form={form} name="address" /></Field>
          <Field label="Country" help="ISO-2" error={e.country}><Input form={form} name="country" maxLength={2} style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="Tax ID / EIN" help="leave empty while pending"><Input form={form} name="tax_id" /></Field>
          <Field label="Email" error={e.email}><Input form={form} name="email" type="email" /></Field>
          <Field label="Phone"><Input form={form} name="phone" /></Field>
          <Field label="Beneficiary"><Input form={form} name="bank_beneficiary" /></Field>
          <Field label="Bank"><Input form={form} name="bank_name" /></Field>
          <Field label="IBAN"><Input form={form} name="bank_iban" mono /></Field>
          <Field label="SWIFT / BIC"><Input form={form} name="bank_swift" mono /></Field>
          <Field label="Account number"><Input form={form} name="bank_account" mono /></Field>
          <Field label="Receiving currency"><Input form={form} name="bank_currency" /></Field>
          <Field label="Beneficiary address" full><Input form={form} name="bank_address" /></Field>
          <Field label="Bank extra" help="correspondent bank, etc." full><Textarea form={form} name="bank_extra" /></Field>
          <Field label="Payment instructions" full><Textarea form={form} name="payment_note" /></Field>
          <Field label="Footer / default legal mentions" full><Textarea form={form} name="footer_text" /></Field>
          <Field label="Default currency"><Select form={form} name="default_currency" options={CURRENCIES} /></Field>
          <Field label="Default profile"><Check form={form} name="is_default">Use for new clients</Check></Field>
        </div>
      </div>
    </Modal>
  );
}
