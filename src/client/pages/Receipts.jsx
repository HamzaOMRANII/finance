import { useState } from 'react';
import { api, useApi, dateTime, money, decimal, shortDate } from '../lib.js';
import { PageHead, Empty, Loading, useToast } from '../ui.jsx';
import { BillModal, ReceiptPreview } from './Bills.jsx';

// Scan the receipts folder, extract what we can, and pre-fill a bill form. Saving is always
// a deliberate click in the form: nothing is created automatically.
export default function Receipts({ meta }) {
  const toast = useToast();
  const [files, reload] = useApi('/receipts');
  const [cards] = useApi('/cards');
  const [selected, setSelected] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);

  const extract = async (path, ai = false) => {
    setSelected(path);
    setResult(null);
    setBusy(true);
    try {
      setResult(await api('/receipts/extract', { method: 'POST', body: { path, ai } }));
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const openForm = async () => {
    const f = result.fields || {};
    const base = result.matching_bill ? await api(`/bills/${result.matching_bill.id}`) : {};
    const currency = f.currency || base.currency || 'EUR';
    setForm({
      bill: base,
      prefill: {
        vendor: f.vendor || base.vendor || '',
        title: f.title || base.title || f.vendor || '',
        receiver_name: f.receiver_name || base.receiver_name || '',
        receiver_country: f.receiver_country || base.receiver_country || '',
        currency,
        amount: f.amount != null ? decimal(f.amount, currency) : decimal(base.amount, currency),
        ...(base.id ? {} : { due_date: f.date || undefined }),
        receipt_file: selected,
      },
    });
  };

  return (
    <>
      <PageHead title="Receipts import" lead={`Files in the receipts folder. Text PDFs are read locally; scans need Claude extraction${meta.receipts_ai ? ' (enabled)' : ' (disabled: set RECEIPTS_AI=true and ANTHROPIC_API_KEY in .env)'}.`}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>Rescan folder</button>
      </PageHead>
      <div className="split">
        <div className="stack">
          {!files ? <Loading /> : files.length === 0 ? <div className="panel"><Empty>The receipts folder is empty.</Empty></div> : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>File</th><th>Added</th><th>Linked</th><th /></tr></thead>
                <tbody>{files.map((f) => (
                  <tr key={f.path} className={`clickable ${selected === f.path ? 'row-ok' : ''}`} onClick={() => extract(f.path)}>
                    <td className="mono" style={{ overflowWrap: 'anywhere' }}>{f.path}</td>
                    <td className="muted">{dateTime(f.modified)}</td>
                    <td className="muted">{f.linked_to || '—'}</td>
                    <td className="actions"><button type="button" className="btn btn-ghost btn-sm">Read</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {busy && <Loading />}
          {result && (
            <div className="panel stack">
              <div className="panel-title"><h2>Detected</h2><span className="hint">via {result.method}</span></div>
              {result.note && <div className="note">{result.note}</div>}
              {result.ai_error && <div className="form-error">Claude: {result.ai_error}</div>}
              <table className="t"><tbody>
                <tr><td className="muted">Vendor</td><td>{result.fields.vendor || '—'}</td></tr>
                <tr><td className="muted">Amount</td><td className="mono">{result.fields.amount != null ? money(result.fields.amount, result.fields.currency) : '—'}</td></tr>
                <tr><td className="muted">Date</td><td className="mono">{result.fields.date ? shortDate(result.fields.date) : '—'}</td></tr>
                <tr><td className="muted">Receiver country</td><td>{result.fields.receiver_country || '—'}</td></tr>
                {result.matching_bill && <tr><td className="muted">Existing bill</td><td>#{result.matching_bill.id} {result.matching_bill.title} (will be updated)</td></tr>}
              </tbody></table>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={openForm}>{result.matching_bill ? 'Review & update bill' : 'Review & create bill'}</button>
                {result.ai_available && result.method !== 'claude' && <button type="button" className="btn btn-ghost" onClick={() => extract(selected, true)}>Ask Claude instead</button>}
              </div>
            </div>
          )}
        </div>
        <div>{selected ? <ReceiptPreview path={selected} /> : <div className="panel"><Empty>Pick a file to preview and read it.</Empty></div>}</div>
      </div>
      {form && (
        <BillModal bill={form.bill} prefill={form.prefill} cards={cards || []} title={form.bill.id ? `Confirm update: ${form.bill.vendor}` : 'Confirm new bill'}
          onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); toast('Saved from receipt'); }} />
      )}
    </>
  );
}
