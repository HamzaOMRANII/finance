import { useEffect, useRef, useState } from 'react';
import { api, useApi, money, shortDate, dateTime, navigate, decimal, today } from '../lib.js';
import { PageHead, Badge, Loading, Modal, Field, Input, Select, Textarea, FormError, useForm, useToast, ConfirmButton } from '../ui.jsx';
import { LineItemsEditor, TaxLinesEditor, Totals, itemsToEdit, taxesToEdit } from './LineItems.jsx';
import { CURRENCIES } from '../../shared/money.mjs';

const EDITABLE = ['draft', 'pending_approval', 'approved'];

export default function InvoiceEditor({ id, query }) {
  if (id === 'new') return <Editor invoice={null} clientId={query.get('client')} />;
  return <Existing id={id} />;
}

function Existing({ id }) {
  const [inv, reload, error] = useApi(`/invoices/${id}`);
  if (error && !inv) return <div className="form-error">{error.message}</div>;
  if (!inv) return <Loading />;
  if (!inv.invoice_number && EDITABLE.includes(inv.status)) return <Editor key={inv.updated_at} invoice={inv} reload={reload} />;
  return <Issued inv={inv} reload={reload} />;
}

// ------------------------------------------------------------ editable (unnumbered) invoice
function Editor({ invoice, clientId, reload }) {
  const toast = useToast();
  const isNew = !invoice;
  const [clients] = useApi('/clients');
  const [issuers] = useApi('/issuers');
  const form = useForm({
    client_id: invoice?.client_id || clientId || '', issuer_profile_id: invoice?.issuer_profile_id || '',
    language: invoice?.language || '', currency: invoice?.currency || 'EUR',
    service_period_start: invoice?.service_period_start || '', service_period_end: invoice?.service_period_end || '',
    scheduled_send_date: invoice?.scheduled_send_date || '', due_date: invoice?.due_date || '',
    requested_number: invoice?.requested_number || '', legal_mentions: invoice?.legal_mentions || '',
    invoice_note: invoice?.invoice_note || '', notes: invoice?.notes || '',
  });
  const [items, setItems] = useState(itemsToEdit(invoice?.line_items, invoice?.currency || 'EUR'));
  const [taxes, setTaxes] = useState(taxesToEdit(invoice?.tax_lines));
  const v = form.values;
  const client = (clients || []).find((c) => String(c.id) === String(v.client_id));

  // new invoice: fill defaults from the chosen client
  useEffect(() => {
    if (!isNew || !client) return;
    form.setValues((s) => ({
      ...s, currency: client.currency, language: client.language,
      issuer_profile_id: s.issuer_profile_id || client.default_issuer_profile_id || (issuers || []).find((i) => i.is_default)?.id || '',
      legal_mentions: s.legal_mentions || client.legal_mentions || '', invoice_note: s.invoice_note || client.invoice_note || '',
    }));
    if (!items.length) setItems([{ description: '', detail: '', quantity: '1', unit: '', unit_price: '', variable_quantity: false }]);
  }, [client?.id, issuers]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = () => ({ ...v, line_items: items, tax_lines: taxes });

  // live PDF preview, debounced
  const [pdfUrl, setPdfUrl] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const urlRef = useRef(null);
  useEffect(() => {
    if (!v.client_id || !v.issuer_profile_id) return undefined;
    const t = setTimeout(async () => {
      try {
        const res = await api('/invoices/preview', { method: 'POST', body: { ...body(), id: invoice?.id }, raw: true });
        const url = URL.createObjectURL(await res.blob());
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPdfUrl(url);
        setPreviewError('');
      } catch (err) {
        setPreviewError(err.message);
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [JSON.stringify(v), JSON.stringify(items), JSON.stringify(taxes)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => urlRef.current && URL.revokeObjectURL(urlRef.current), []);

  const save = () => form.submit(async () => {
    if (isNew) {
      const out = await api('/invoices', { method: 'POST', body: body() });
      toast('Draft created');
      navigate(`/invoices/${out.id}`);
    } else {
      await api(`/invoices/${invoice.id}`, { method: 'PUT', body: body() });
      toast('Draft saved');
      reload();
    }
  });
  const act = (fn, msg) => form.submit(async () => {
    await fn();
    toast(msg);
    reload();
  });
  const approve = () => act(() => api(`/invoices/${invoice.id}/approve`, { method: 'POST', body: body() }), 'Approved');
  const approveAndSend = () => {
    const to = client?.billing_emails?.join(', ');
    if (!window.confirm(`Number this invoice (${invoice.next_number}) and email it to ${to}? This cannot be undone.`)) return;
    act(async () => {
      if (invoice.status !== 'approved') await api(`/invoices/${invoice.id}/approve`, { method: 'POST', body: body() });
      else await api(`/invoices/${invoice.id}`, { method: 'PUT', body: body() });
      const out = await api(`/invoices/${invoice.id}/send`, { method: 'POST', body: {} });
      if (out.skipped) throw new Error(out.skipped);
    }, 'Invoice sent');
  };
  const markSent = () => {
    const note = window.prompt(`Number this invoice (${invoice.next_number}) and record it as sent outside FinTrack. How was it delivered?`, 'downloaded and sent by hand');
    if (note === null) return;
    act(async () => {
      if (invoice.status !== 'approved') await api(`/invoices/${invoice.id}/approve`, { method: 'POST', body: body() });
      await api(`/invoices/${invoice.id}/mark-sent`, { method: 'POST', body: { note } });
    }, 'Invoice numbered and marked as sent');
  };
  const removeDraft = () => form.submit(async () => {
    await api(`/invoices/${invoice.id}`, { method: 'DELETE' });
    toast('Draft deleted');
    navigate('/invoices');
  });

  const canSend = !!client?.billing_emails?.length;
  const autoNumber = invoice?.auto_number || 'the next free number';
  const terms = client?.payment_terms_days ?? 0;
  return (
    <>
      <PageHead title={isNew ? 'New invoice' : `Draft for ${client?.company_name || '…'}`} back="/invoices"
        lead={isNew ? 'One-off invoice. It gets its number only when sent.' : `Status ${invoice.status.replace('_', ' ')}${invoice.scheduled_send_date ? ` · planned send ${shortDate(invoice.scheduled_send_date)}` : ''} · will be ${invoice.next_number}`}>
        {!isNew && <a className="btn btn-ghost" href={`/api/invoices/${invoice.id}/pdf?download=1`}>PDF</a>}
        {!isNew && invoice.has_docx && <a className="btn btn-ghost" href={`/api/invoices/${invoice.id}/docx`}>DOCX</a>}
        {!isNew && <ConfirmButton className="btn btn-danger" confirm="Delete this draft? It has no number, so nothing is lost from the sequence." onConfirm={removeDraft}>Delete draft</ConfirmButton>}
        <button type="button" className="btn btn-ghost" onClick={save} disabled={form.busy}>{isNew ? 'Create draft' : 'Save'}</button>
        {!isNew && invoice.status !== 'approved' && <button type="button" className="btn btn-ghost" onClick={approve} disabled={form.busy}>Approve</button>}
        {!isNew && <button type="button" className="btn btn-ghost" onClick={markSent} disabled={form.busy}>Mark as sent…</button>}
        {!isNew && <button type="button" className="btn btn-gold" onClick={approveAndSend} disabled={form.busy || !canSend} title={canSend ? '' : 'client has no billing email'}>Approve & send</button>}
      </PageHead>
      {!isNew && invoice.status === 'approved' && invoice.scheduled_send_date > today() && <div className="note info">Approved. The daily job emails it on {shortDate(invoice.scheduled_send_date)} at 08:00, or send it now.</div>}
      {client && !canSend && <div className="note">{client.company_name} has no billing email: add one on the client to send from here, or use “Mark as sent” after delivering the PDF yourself.</div>}
      <FormError form={form} />
      <div className="split">
        <div className="stack">
          <div className="panel">
            <div className="form">
              <Field label="Client" error={form.errors.client_id}><Select form={form} name="client_id" empty="—" options={(clients || []).map((c) => [c.id, c.company_name])} /></Field>
              <Field label="Issuer" error={form.errors.issuer_profile_id}><Select form={form} name="issuer_profile_id" empty="—" options={(issuers || []).map((i) => [i.id, `${i.legal_name} (${i.prefix})`])} /></Field>
              <Field label="Language"><Select form={form} name="language" options={[['FR', 'Français'], ['EN', 'English']]} /></Field>
              <Field label="Currency"><Select form={form} name="currency" options={CURRENCIES} /></Field>
              <Field label="Service period start"><Input form={form} name="service_period_start" type="date" /></Field>
              <Field label="Service period end"><Input form={form} name="service_period_end" type="date" /></Field>
              <Field label="Invoice reference" help={`empty = ${autoNumber}`} error={form.errors.requested_number}><Input form={form} name="requested_number" mono placeholder={invoice?.auto_number || 'INV-2026-10-001'} /></Field>
              <Field label="Due date" help={`empty = invoice date + ${terms} days`} error={form.errors.due_date}><Input form={form} name="due_date" type="date" /></Field>
            </div>
          </div>
          <div className="panel stack">
            <div className="panel-title"><h2>Lines</h2>{items.some((i) => i.variable_quantity) && <span className="hint" style={{ color: 'var(--gold)' }}>check the variable quantities</span>}</div>
            <LineItemsEditor items={items} onChange={setItems} currency={v.currency} />
            <TaxLinesEditor taxes={taxes} onChange={setTaxes} />
            <Totals items={items} taxes={taxes} currency={v.currency} />
          </div>
          <div className="panel">
            <div className="form">
              <Field label="Legal mentions" help="from the client; edit only with your accountant's wording" full><Textarea form={form} name="legal_mentions" /></Field>
              <Field label="Note on the invoice" full><Textarea form={form} name="invoice_note" /></Field>
              <Field label="Internal notes" help="not printed" full><Textarea form={form} name="notes" /></Field>
            </div>
          </div>
        </div>
        <div className="stack">
          {previewError && <div className="form-error">{previewError}</div>}
          {pdfUrl ? <iframe className="pdf-frame" src={pdfUrl} title="Invoice preview" /> : <div className="panel"><div className="empty">Pick a client and an issuer to see the PDF.</div></div>}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------ numbered (sent) invoice
function Issued({ inv, reload }) {
  const toast = useToast();
  const [dialog, setDialog] = useState(null);
  const left = inv.total - inv.amount_received - inv.credited;
  const voidUnsent = async () => {
    try {
      await api(`/invoices/${inv.id}/void`, { method: 'POST', body: { reason: 'voided before sending' } });
      toast('Voided (number kept in the sequence)');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const retrySend = async () => {
    try {
      const out = await api(`/invoices/${inv.id}/send`, { method: 'POST', body: {} });
      toast(out.skipped || 'Invoice sent', out.skipped ? 'bad' : 'ok');
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };
  return (
    <>
      <PageHead title={inv.invoice_number} back="/invoices" lead={`${inv.client.company_name} · issued ${shortDate(inv.issue_date)} · due ${shortDate(inv.due_date)}${inv.is_legacy ? ' · imported (issued before FinTrack)' : ''}`}>
        <a className="btn btn-ghost" href={`/api/invoices/${inv.id}/pdf?download=1`}>Download PDF</a>
        {inv.has_docx && <a className="btn btn-ghost" href={`/api/invoices/${inv.id}/docx`}>Download DOCX</a>}
        {!inv.sent_at && inv.status !== 'void' && <button type="button" className="btn btn-gold" onClick={retrySend}>Send now</button>}
        {!inv.sent_at && inv.status !== 'void' && <ConfirmButton className="btn btn-danger" confirm="Void this unsent invoice? Its number stays used." onConfirm={voidUnsent}>Void</ConfirmButton>}
        {inv.sent_at && !['paid', 'void'].includes(inv.status) && <button type="button" className="btn btn-primary" onClick={() => setDialog('pay')}>Record payment</button>}
        {inv.sent_at && inv.status !== 'void' && <button type="button" className="btn btn-ghost" onClick={() => setDialog('credit')}>Credit note</button>}
      </PageHead>
      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Status</div><div className="kpi-value" style={{ fontSize: 18 }}><Badge status={inv.status} /></div></div>
        <div className="kpi"><div className="kpi-label">Total</div><div className="kpi-value">{money(inv.total, inv.currency)}</div></div>
        <div className="kpi ok"><div className="kpi-label">Received</div><div className="kpi-value">{money(inv.amount_received, inv.currency)}</div></div>
        {inv.credited > 0 && <div className="kpi"><div className="kpi-label">Credited</div><div className="kpi-value">{money(inv.credited, inv.currency)}</div></div>}
        <div className={`kpi ${left > 0 ? 'accent' : 'ok'}`}><div className="kpi-label">Left to receive</div><div className="kpi-value">{money(Math.max(left, 0), inv.currency)}</div></div>
      </div>
      <div className="split">
        <div className="stack">
          <div className="panel">
            <div className="panel-title"><h2>Delivery</h2></div>
            <div className="cell-sub">{inv.sent_at ? `Sent ${dateTime(inv.sent_at)}` : 'Not sent yet'}</div>
            {inv.sent_to && <div className="mono" style={{ marginTop: 6, fontSize: 12.5 }}>{inv.sent_to.manual ? `manual: ${inv.sent_to.note || ''}` : `to ${inv.sent_to.to.join(', ')}${inv.sent_to.cc?.length ? ` · cc ${inv.sent_to.cc.join(', ')}` : ''}`}</div>}
          </div>
          {inv.payments.length > 0 && (
            <div className="table-wrap"><table className="t"><thead><tr><th>Payment</th><th className="num">Amount</th><th>Note</th></tr></thead>
              <tbody>{inv.payments.map((p) => <tr key={p.id}><td className="mono">{shortDate(p.paid_date)}</td><td className="num">{money(p.amount, inv.currency)}</td><td className="muted">{p.note}</td></tr>)}</tbody></table></div>
          )}
          {inv.credit_notes.length > 0 && (
            <div className="table-wrap"><table className="t"><thead><tr><th>Credit note</th><th>Date</th><th className="num">Total</th><th /></tr></thead>
              <tbody>{inv.credit_notes.map((c) => <tr key={c.id}><td className="mono">{c.credit_number}<div className="cell-sub">{c.reason}</div></td><td className="mono">{shortDate(c.issue_date)}</td><td className="num">{money(c.total, c.currency)}</td>
                <td className="actions"><a className="btn btn-ghost btn-sm" href={`/api/credit-notes/${c.id}/pdf`} target="_blank" rel="noreferrer">PDF</a></td></tr>)}</tbody></table></div>
          )}
          <div className="panel">
            <div className="panel-title"><h2>Audit trail</h2></div>
            <div className="timeline">
              {inv.events.map((e) => (
                <div key={e.id} className="tl"><time>{dateTime(e.created_at)}</time><span><Badge tone={e.actor === 'automation' ? 'b-violet' : 'b-dim'}>{e.type.replace('_', ' ')}</Badge> <span className="muted">{eventText(e, inv.currency)}</span></span></div>
              ))}
              {!inv.events.length && <span className="muted">No events (imported invoice).</span>}
            </div>
          </div>
        </div>
        <iframe className="pdf-frame" src={`/api/invoices/${inv.id}/pdf`} title={`Invoice ${inv.invoice_number}`} />
      </div>
      {dialog === 'pay' && <PaymentModal inv={inv} left={left} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {dialog === 'credit' && <CreditModal inv={inv} left={left + inv.amount_received} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
    </>
  );
}

function eventText(e, currency) {
  const d = e.detail || {};
  if (e.type === 'sent') return d.manual ? 'recorded as sent manually' : `to ${(d.to || []).join(', ')}`;
  if (e.type === 'numbered') return d.invoice_number;
  if (e.type === 'payment' || e.type === 'paid') return `${money(d.amount, currency)} on ${d.paid_date}`;
  if (e.type === 'credit_note') return `${d.credit_number}: ${d.reason}`;
  if (e.type === 'created') return d.schedule_id ? `from schedule, period ${d.period}` : 'manually';
  if (e.type.startsWith('reminder')) return d.to ? `to ${[].concat(d.to).join(', ')}` : '';
  return '';
}

function PaymentModal({ inv, left, onClose, onDone }) {
  const toast = useToast();
  const form = useForm({ paid_date: today(), amount: decimal(Math.max(left, 0), inv.currency), note: '' });
  const save = () => form.submit(async (v) => {
    const out = await api(`/invoices/${inv.id}/payments`, { method: 'POST', body: v });
    toast(out.status === 'paid' ? 'Invoice fully paid' : 'Partial payment recorded');
    onDone();
  });
  return (
    <Modal title={`Payment for ${inv.invoice_number}`} onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={form.busy}>Record</button></>}>
      <div className="stack">
        <FormError form={form} />
        <div className="form">
          <Field label="Received on"><Input form={form} name="paid_date" type="date" /></Field>
          <Field label={`Amount (${inv.currency})`} help={`left ${money(left, inv.currency)}`} error={form.errors.amount}><Input form={form} name="amount" mono inputMode="decimal" /></Field>
          <Field label="Note" full><Input form={form} name="note" placeholder="Wise transfer ref…" /></Field>
        </div>
      </div>
    </Modal>
  );
}

function CreditModal({ inv, onClose, onDone }) {
  const toast = useToast();
  const [full, setFull] = useState(true);
  const [items, setItems] = useState([{ description: '', detail: '', quantity: '1', unit: '', unit_price: '', variable_quantity: false }]);
  const form = useForm({ reason: '' });
  const save = () => {
    if (!window.confirm('Issue this credit note? It gets its own number and cannot be changed or deleted.')) return;
    form.submit(async (v) => {
      const out = await api(`/invoices/${inv.id}/credit-notes`, { method: 'POST', body: { reason: v.reason, full, line_items: full ? undefined : items } });
      toast(`Credit note ${out.credit_number} issued`);
      onDone();
    });
  };
  return (
    <Modal title={`Credit note for ${inv.invoice_number}`} onClose={onClose} wide
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-gold" onClick={save} disabled={form.busy}>Issue credit note</button></>}>
      <div className="stack">
        <div className="note info">A credit note is the legal way to correct a sent invoice: the original stays untouched. Re-issue a corrected invoice afterwards if needed.</div>
        <FormError form={form} />
        <Field label="Reason" error={form.errors.reason}><Input form={form} name="reason" placeholder="Erreur sur le nombre de jours" /></Field>
        <div className="row">
          <label className="check"><input type="radio" checked={full} onChange={() => setFull(true)} /> Cancel the full invoice ({money(inv.total, inv.currency)})</label>
          <label className="check"><input type="radio" checked={!full} onChange={() => setFull(false)} /> Partial credit</label>
        </div>
        {!full && <><LineItemsEditor items={items} onChange={setItems} currency={inv.currency} /><Totals items={items} taxes={[]} currency={inv.currency} /></>}
      </div>
    </Modal>
  );
}
