// Line items + tax lines editor, shared by schedules, the invoice editor and the approval queue.
// Prices are edited as decimal strings in the invoice currency; the API stores minor units.
import { money, decimal } from '../lib.js';
import { toMinor, lineAmount } from '../../shared/money.mjs';

export const itemsToEdit = (items, currency) => (items || []).map((it) => ({
  description: it.description || '', detail: it.detail || '', quantity: String(it.quantity ?? 1), unit: it.unit || '',
  unit_price: decimal(it.unit_price, currency), variable_quantity: !!it.variable_quantity,
}));
export const taxesToEdit = (taxes) => (taxes || []).map((t) => ({ label: t.label, rate: String(t.rate) }));

export function totalsOf(items, taxes, currency) {
  const sub = items.reduce((s, it) => {
    const p = toMinor(it.unit_price, currency);
    const q = Number(String(it.quantity).replace(',', '.'));
    return s + (Number.isFinite(p) && Number.isFinite(q) ? lineAmount(q, p) : 0);
  }, 0);
  const tax = taxes.reduce((s, t) => s + Math.round((sub * (Number(String(t.rate).replace(',', '.')) || 0)) / 100), 0);
  return { sub, tax, total: sub + tax };
}

export function LineItemsEditor({ items, onChange, currency, readOnly, quantityOnly, showVariable }) {
  const set = (i, k, v) => onChange(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const add = () => onChange([...items, { description: '', detail: '', quantity: '1', unit: '', unit_price: '', variable_quantity: false }]);
  const del = (i) => onChange(items.filter((_, j) => j !== i));
  const lock = readOnly || quantityOnly;
  return (
    <div className="lines">
      <div className="line-head"><span>Qty</span><span>Unit</span><span>Unit price</span><span style={{ textAlign: 'right' }}>Amount</span><span /></div>
      {items.map((it, i) => {
        const p = toMinor(it.unit_price, currency);
        const q = Number(String(it.quantity).replace(',', '.'));
        const amount = Number.isFinite(p) && Number.isFinite(q) && p !== null ? money(lineAmount(q, p), currency) : '—';
        return (
          <div key={i} className={`line${it.variable_quantity ? ' var' : ''}`}>
            <div className="desc">
              <input className="input" placeholder="Description ({Month} {year} are filled in)" value={it.description} disabled={lock} onChange={(e) => set(i, 'description', e.target.value)} />
              <textarea className="textarea" style={{ minHeight: 44 }} placeholder="Detail (optional)" value={it.detail} disabled={lock} onChange={(e) => set(i, 'detail', e.target.value)} />
              {showVariable && (
                <label className="check" style={{ fontSize: 12.5 }}>
                  <input type="checkbox" checked={it.variable_quantity} disabled={readOnly} onChange={(e) => set(i, 'variable_quantity', e.target.checked)} />
                  variable quantity (e.g. days worked): always asks for approval
                </label>
              )}
            </div>
            <input className="input mono" aria-label="Quantity" placeholder="qty" value={it.quantity} disabled={readOnly} inputMode="decimal" onChange={(e) => set(i, 'quantity', e.target.value)} />
            <input className="input" aria-label="Unit" placeholder="days" value={it.unit} disabled={lock} onChange={(e) => set(i, 'unit', e.target.value)} />
            <input className="input mono" aria-label="Unit price" placeholder="unit price" value={it.unit_price} disabled={lock} inputMode="decimal" onChange={(e) => set(i, 'unit_price', e.target.value)} />
            <div className="amount">{amount}</div>
            {!lock ? <button type="button" className="x" aria-label="Remove line" onClick={() => del(i)}>×</button> : <span />}
          </div>
        );
      })}
      {!lock && <div><button type="button" className="btn btn-ghost btn-sm" onClick={add}>+ Line</button></div>}
    </div>
  );
}

export function TaxLinesEditor({ taxes, onChange, readOnly }) {
  const set = (i, k, v) => onChange(taxes.map((t, j) => (j === i ? { ...t, [k]: v } : t)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {taxes.map((t, i) => (
        <div key={i} className="row">
          <input className="input" style={{ flex: 1 }} placeholder="Tax label (e.g. TVA)" value={t.label} disabled={readOnly} onChange={(e) => set(i, 'label', e.target.value)} />
          <input className="input mono" style={{ width: 90 }} placeholder="%" value={t.rate} disabled={readOnly} onChange={(e) => set(i, 'rate', e.target.value)} />
          {!readOnly && <button type="button" className="x" aria-label="Remove tax" onClick={() => onChange(taxes.filter((_, j) => j !== i))}>×</button>}
        </div>
      ))}
      {!readOnly && <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...taxes, { label: '', rate: '' }])}>+ Tax line</button></div>}
    </div>
  );
}

export function Totals({ items, taxes, currency }) {
  const t = totalsOf(items, taxes, currency);
  return (
    <div className="totals">
      <span>Subtotal {money(t.sub, currency)}</span>
      {taxes.length > 0 && <span>Tax {money(t.tax, currency)}</span>}
      <span className="grand">Total {money(t.total, currency)}</span>
    </div>
  );
}
