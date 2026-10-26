import { useState } from 'react';
import { api, useApi, money, shortDate } from '../lib.js';
import { PageHead, Badge, Empty, Loading, Modal, Field, Input, Select, Textarea, Check, FormError, useForm, useToast, ConfirmButton } from '../ui.jsx';
import { LineItemsEditor, TaxLinesEditor, Totals, itemsToEdit, taxesToEdit } from './LineItems.jsx';
import { CURRENCIES } from '../../shared/money.mjs';

export default function Schedules() {
  const [rows, reload] = useApi('/schedules');
  const [editing, setEditing] = useState(null);
  return (
    <>
      <PageHead title="Recurring invoices" lead="The daily 08:00 job creates each invoice from its schedule. approve_first: a draft is ready 3 days before the send date and is never sent without your approval.">
        <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>+ New schedule</button>
      </PageHead>
      {!rows ? <Loading /> : rows.length === 0 ? <div className="panel"><Empty>No schedules.</Empty></div> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Client</th><th>Issuer</th><th>Rule</th><th>Mode</th><th>Next draft</th><th>Next send</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className={`clickable ${s.active ? (s.line_items.length ? 'row-ok' : 'row-warn') : ''}`} onClick={() => setEditing(s)}>
                <td><div className="cell-title">{s.company_name}</div><div className="cell-sub">{s.name}</div></td>
                <td className="mono">{s.prefix}</td>
                <td className="muted">{s.frequency}{s.frequency === 'custom' ? ` /${s.interval_months}mo` : ''} · {s.send_rule === 'fixed_day' ? `day ${s.send_day}` : 'last business day'}</td>
                <td><Badge tone={s.mode === 'auto_send' ? 'b-violet' : 'b-warn'}>{s.mode.replace('_', ' ')}</Badge></td>
                <td className="mono">{s.draft_date ? shortDate(s.draft_date) : '—'}</td>
                <td className="mono">{s.active ? shortDate(s.next_run_date) : <Badge tone="b-dim">paused</Badge>}</td>
                <td className="num">{money(s.total, s.currency)}</td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  <a className="btn btn-ghost btn-sm" href={`/api/schedules/${s.id}/preview.pdf`} target="_blank" rel="noreferrer">Preview PDF</a>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <ScheduleModal schedule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function ScheduleModal({ schedule, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !schedule.id;
  const [clients] = useApi('/clients');
  const [issuers] = useApi('/issuers');
  const form = useForm({
    name: schedule.name || '', client_id: schedule.client_id || '', issuer_profile_id: schedule.issuer_profile_id || '',
    currency: schedule.currency || 'EUR', frequency: schedule.frequency || 'monthly', interval_months: schedule.interval_months || 1,
    send_rule: schedule.send_rule || 'last_business_day', send_day: schedule.send_day || '', mode: schedule.mode || 'approve_first',
    approval_lead_days: schedule.approval_lead_days ?? 3, active: schedule.active ?? true, next_run_date: schedule.next_run_date || '', notes: schedule.notes || '',
  });
  const [items, setItems] = useState(itemsToEdit(schedule.line_items, schedule.currency || 'EUR'));
  const [taxes, setTaxes] = useState(taxesToEdit(schedule.tax_lines));
  const v = form.values;
  const onClient = (e) => {
    const c = (clients || []).find((x) => String(x.id) === e.target.value);
    form.setValues((s) => ({ ...s, client_id: e.target.value, currency: c?.currency || s.currency, issuer_profile_id: s.issuer_profile_id || c?.default_issuer_profile_id || '' }));
  };
  const save = (recompute) => form.submit(async (vals) => {
    const body = { ...vals, line_items: items, tax_lines: taxes, recompute_next_run: recompute || undefined };
    if (recompute) delete body.next_run_date;
    if (isNew) await api('/schedules', { method: 'POST', body });
    else await api(`/schedules/${schedule.id}`, { method: 'PUT', body });
    toast('Schedule saved');
    onSaved();
  });
  const remove = () => form.submit(async () => {
    const out = await api(`/schedules/${schedule.id}`, { method: 'DELETE' });
    toast(out.deactivated ? 'Schedule has invoices: it was paused instead' : 'Schedule deleted');
    onSaved();
  });
  return (
    <Modal title={isNew ? 'New recurring invoice' : `Schedule: ${schedule.company_name}`} onClose={onClose} wide
      footer={<>
        {!isNew && <ConfirmButton className="btn btn-danger" confirm="Delete this schedule? (It is paused instead if it already produced invoices.)" onConfirm={remove}>Delete</ConfirmButton>}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        {!isNew && <button type="button" className="btn btn-ghost" onClick={() => save(true)} disabled={form.busy}>Save & recompute next date</button>}
        <button type="button" className="btn btn-primary" onClick={() => save(false)} disabled={form.busy}>Save</button>
      </>}>
      <div className="stack">
        <FormError form={form} />
        <div className="form">
          <Field label="Client" error={form.errors.client_id}>
            <select className="select" value={v.client_id} onChange={onClient}><option value="">—</option>{(clients || []).map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}</select>
          </Field>
          <Field label="Issuer profile" error={form.errors.issuer_profile_id}><Select form={form} name="issuer_profile_id" empty="—" options={(issuers || []).map((i) => [i.id, `${i.legal_name} (${i.prefix})`])} /></Field>
          <Field label="Name"><Input form={form} name="name" /></Field>
          <Field label="Currency"><Select form={form} name="currency" options={CURRENCIES} /></Field>
          <Field label="Frequency"><Select form={form} name="frequency" options={['monthly', 'quarterly', 'custom']} /></Field>
          {v.frequency === 'custom' && <Field label="Every N months"><Input form={form} name="interval_months" type="number" min="1" max="24" /></Field>}
          <Field label="Send rule"><Select form={form} name="send_rule" options={[['last_business_day', 'Last business day of the month (Mon–Fri)'], ['fixed_day', 'Fixed day of the month']]} /></Field>
          {v.send_rule === 'fixed_day' && <Field label="Day" error={form.errors.send_day}><Input form={form} name="send_day" type="number" min="1" max="31" /></Field>}
          <Field label="Mode"><Select form={form} name="mode" options={[['approve_first', 'approve_first: draft, wait for my approval'], ['auto_send', 'auto_send: email automatically']]} /></Field>
          {v.mode === 'approve_first' && <Field label="Draft lead time" help="days before send"><Input form={form} name="approval_lead_days" type="number" min="0" max="14" /></Field>}
          <Field label="Next send date" help={isNew ? 'empty = computed' : 'edit to skip or move a run'} error={form.errors.next_run_date}><Input form={form} name="next_run_date" type="date" /></Field>
          <Field label="Active"><Check form={form} name="active">Generate invoices from this schedule</Check></Field>
        </div>
        <div className="note info">Placeholders in descriptions: <code>{'{Month}'}</code> <code>{'{month}'}</code> <code>{'{year}'}</code> <code>{'{period}'}</code>, filled in the client's language.</div>
        <LineItemsEditor items={items} onChange={setItems} currency={v.currency} showVariable />
        <div className="split">
          <div><div className="panel-title"><h2>Tax lines</h2><span className="hint">only if your accountant says so</span></div><TaxLinesEditor taxes={taxes} onChange={setTaxes} /></div>
          <Totals items={items} taxes={taxes} currency={v.currency} />
        </div>
        <Field label="Notes" full><Textarea form={form} name="notes" /></Field>
      </div>
    </Modal>
  );
}
