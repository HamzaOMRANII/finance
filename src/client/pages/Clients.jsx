import { useState } from 'react';
import { api, useApi, money, shortDate, go, navigate } from '../lib.js';
import { PageHead, Badge, Flag, Empty, Loading, Modal, Field, Input, Select, Textarea, Check, FormError, useForm, useToast, ConfirmButton } from '../ui.jsx';
import { CURRENCIES } from '../../shared/money.mjs';

export default function Clients() {
  const [rows, reload] = useApi('/clients');
  const [editing, setEditing] = useState(null);
  return (
    <>
      <PageHead title="Clients" lead="Invoices are only ever emailed to the billing and cc addresses stored here.">
        <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>+ New client</button>
      </PageHead>
      {!rows ? <Loading /> : rows.length === 0 ? <div className="panel"><Empty>No clients yet.</Empty></div> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Company</th><th>Country</th><th>Billing email</th><th>Lang</th><th>Terms</th><th className="num">Invoices</th><th className="num">Outstanding</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={go(`/clients/${c.id}`)}>
                <td><div className="cell-title">{c.company_name}</div><div className="cell-sub">{c.contact_name}</div></td>
                <td><Flag code={c.country} withName /></td>
                <td className="mono">{c.billing_emails.join(', ') || <Badge tone="b-warn">missing</Badge>}</td>
                <td className="mono">{c.language}</td>
                <td className="muted">{c.payment_terms_days ? `${c.payment_terms_days} days` : 'on receipt'}</td>
                <td className="num">{c.invoice_count}</td>
                <td className="num">{money(c.outstanding, c.currency)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <ClientModal client={editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); reload(); if (id) navigate(`/clients/${id}`); }} />}
    </>
  );
}

export function ClientDetail({ id }) {
  const [c, reload] = useApi(`/clients/${id}`);
  const [editing, setEditing] = useState(false);
  if (!c) return <Loading />;
  return (
    <>
      <PageHead title={c.company_name} back="/clients" lead={[c.contact_name, c.vat_number && `VAT ${c.vat_number}`, c.registration_id && `SIRET ${c.registration_id}`].filter(Boolean).join(' · ')}>
        <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>Edit client</button>
        <a className="btn btn-primary" href={`/invoices/new?client=${c.id}`} onClick={go(`/invoices/new?client=${c.id}`)}>+ One-off invoice</a>
      </PageHead>
      {!c.billing_emails.length && <div className="note">No billing email: invoices can be generated and downloaded but not emailed. Add one to enable sending.</div>}
      {!c.legal_mentions && <div className="note">Legal mentions (VAT / reverse-charge wording) are empty. Add the exact text from your accountant; FinTrack never invents tax wording.</div>}
      <div className="grid-3">
        <div className="panel"><div className="kpi-label">Billing</div><div style={{ marginTop: 8 }}>{c.billing_emails.join(', ') || '—'}</div><div className="cell-sub">cc {c.cc_emails.join(', ') || '—'}</div></div>
        <div className="panel"><div className="kpi-label">Terms</div><div style={{ marginTop: 8 }}>{c.payment_terms_days ? `${c.payment_terms_days} days` : 'Due on receipt'} · {c.currency} · {c.language}</div><div className="cell-sub">client reminders {c.client_reminders ? 'on (+7 days)' : 'off'}</div></div>
        <div className="panel"><div className="kpi-label">Address</div><div style={{ marginTop: 8, whiteSpace: 'pre-line' }}>{c.address || '—'}</div><div className="cell-sub"><Flag code={c.country} withName /></div></div>
      </div>
      <section>
        <div className="panel-title"><h2>Invoice history</h2></div>
        {c.invoices.length === 0 ? <div className="panel"><Empty>No invoices yet.</Empty></div> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Number</th><th>Issued</th><th>Period</th><th className="num">Total</th><th className="num">Received</th><th>Status</th><th /></tr></thead>
              <tbody>{c.invoices.map((o) => (
                <tr key={o.id} className="clickable" onClick={go(`/invoices/${o.id}`)}>
                  <td className="mono">{o.invoice_number || <span className="muted">draft #{o.id}</span>}{o.is_legacy ? <span className="cell-sub"> · legacy</span> : null}</td>
                  <td className="mono">{shortDate(o.issue_date || o.scheduled_send_date)}</td>
                  <td className="muted">{o.service_period_start ? `${shortDate(o.service_period_start)} – ${shortDate(o.service_period_end)}` : '—'}</td>
                  <td className="num">{money(o.total, o.currency)}</td>
                  <td className="num">{money(o.amount_received, o.currency)}</td>
                  <td><Badge status={o.status} /></td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    <a className="btn btn-ghost btn-sm" href={`/api/invoices/${o.id}/pdf?download=1`}>PDF</a>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      {c.credit_notes.length > 0 && (
        <section>
          <div className="panel-title"><h2>Credit notes</h2></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Number</th><th>For</th><th>Date</th><th>Reason</th><th className="num">Total</th><th /></tr></thead>
              <tbody>{c.credit_notes.map((n) => (
                <tr key={n.id}><td className="mono">{n.credit_number}</td><td className="mono">{n.invoice_number}</td><td className="mono">{shortDate(n.issue_date)}</td>
                  <td className="muted">{n.reason}</td><td className="num">{money(n.total, n.currency)}</td>
                  <td className="actions"><a className="btn btn-ghost btn-sm" href={`/api/credit-notes/${n.id}/pdf?download=1`}>PDF</a></td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
      {editing && <ClientModal client={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </>
  );
}

const FIELDS = ['company_name', 'contact_name', 'phone', 'address', 'country', 'registration_id', 'vat_number', 'currency', 'payment_terms_days',
  'legal_mentions', 'invoice_note', 'language', 'default_issuer_profile_id', 'client_reminders', 'notes'];

function ClientModal({ client, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !client.id;
  const [issuers] = useApi('/issuers');
  const form = useForm({
    ...Object.fromEntries(FIELDS.map((k) => [k, client[k] ?? ''])),
    currency: client.currency || 'EUR', language: client.language || 'EN', payment_terms_days: client.payment_terms_days ?? 30,
    client_reminders: !!client.client_reminders,
    billing_emails: (client.billing_emails || []).join(', '), cc_emails: (client.cc_emails || []).join(', '),
  });
  const save = () => form.submit(async (v) => {
    const out = isNew ? await api('/clients', { method: 'POST', body: v }) : await api(`/clients/${client.id}`, { method: 'PUT', body: v });
    toast('Client saved');
    onSaved(isNew ? out.id : null);
  });
  const remove = () => form.submit(async () => {
    await api(`/clients/${client.id}`, { method: 'DELETE' });
    toast('Client deleted');
    navigate('/clients');
  });
  const e = form.errors;
  return (
    <Modal title={isNew ? 'New client' : client.company_name} onClose={onClose} wide
      footer={<>
        {!isNew && <ConfirmButton className="btn btn-danger" confirm="Delete this client?" onConfirm={remove}>Delete</ConfirmButton>}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={form.busy}>Save</button>
      </>}>
      <div className="stack">
        <FormError form={form} />
        <div className="form">
          <Field label="Company name" error={e.company_name}><Input form={form} name="company_name" /></Field>
          <Field label="Contact name"><Input form={form} name="contact_name" /></Field>
          <Field label="Billing emails" help="comma separated" error={e.billing_emails}><Input form={form} name="billing_emails" /></Field>
          <Field label="CC emails" error={e.cc_emails}><Input form={form} name="cc_emails" /></Field>
          <Field label="Address" full><Textarea form={form} name="address" /></Field>
          <Field label="Country" help="ISO-2" error={e.country}><Input form={form} name="country" maxLength={2} style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="Phone"><Input form={form} name="phone" /></Field>
          <Field label="Company number" help="SIREN / SIRET"><Input form={form} name="registration_id" mono /></Field>
          <Field label="VAT number"><Input form={form} name="vat_number" mono /></Field>
          <Field label="Currency"><Select form={form} name="currency" options={CURRENCIES} /></Field>
          <Field label="Payment terms" help="days, 0 = on receipt" error={e.payment_terms_days}><Input form={form} name="payment_terms_days" type="number" min="0" /></Field>
          <Field label="Language" help="PDF + email"><Select form={form} name="language" options={[['FR', 'Français'], ['EN', 'English']]} /></Field>
          <Field label="Default issuer"><Select form={form} name="default_issuer_profile_id" empty="—" options={(issuers || []).map((i) => [i.id, i.legal_name])} /></Field>
          <Field label="Legal mentions" help="exact VAT / reverse-charge text from your accountant" full><Textarea form={form} name="legal_mentions" /></Field>
          <Field label="Invoice note" help="printed on every invoice" full><Textarea form={form} name="invoice_note" /></Field>
          <Field label="Reminders" full><Check form={form} name="client_reminders">Email the client a polite reminder 7 days after the due date</Check></Field>
          <Field label="Internal notes" full><Textarea form={form} name="notes" /></Field>
        </div>
      </div>
    </Modal>
  );
}
