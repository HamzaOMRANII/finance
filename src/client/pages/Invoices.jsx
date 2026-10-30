import { useState } from 'react';
import { useApi, money, shortDate, go } from '../lib.js';
import { PageHead, Badge, Empty, Loading } from '../ui.jsx';

const STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'paid', 'partially_paid', 'overdue', 'void'];

export default function Invoices() {
  const [filters, setFilters] = useState({ status: '', client: '', issuer: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const [rows] = useApi(`/invoices${qs ? `?${qs}` : ''}`);
  const [clients] = useApi('/clients');
  const [issuers] = useApi('/issuers');
  const f = (k) => (e) => setFilters((s) => ({ ...s, [k]: e.target.value }));
  return (
    <>
      <PageHead title="Invoices" lead="Outgoing invoices. Numbers are given when an invoice is sent and never reused; sent invoices are corrected with credit notes.">
        <a className="btn btn-primary" href="/invoices/new" onClick={go('/invoices/new')}>+ One-off invoice</a>
      </PageHead>
      <div className="filters">
        <select className="select" value={filters.status} onChange={f('status')}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
        <select className="select" value={filters.client} onChange={f('client')}><option value="">All clients</option>{(clients || []).map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}</select>
        <select className="select" value={filters.issuer} onChange={f('issuer')}><option value="">All issuers</option>{(issuers || []).map((i) => <option key={i.id} value={i.id}>{i.legal_name}</option>)}</select>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <div className="panel"><Empty>No invoices.</Empty></div> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Number</th><th>Client</th><th>Issuer</th><th>Date</th><th>Due</th><th className="num">Total</th><th className="num">Received</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id} className={`clickable ${o.status === 'overdue' ? 'row-danger' : o.status === 'pending_approval' ? 'row-warn' : ''}`} onClick={go(`/invoices/${o.id}`)}>
                <td className="mono">{o.invoice_number || <>{o.next_number || `#${o.id}`}<span className="cell-sub"> draft</span></>}</td>
                <td className="cell-title">{o.company_name}</td>
                <td className="mono">{o.prefix}</td>
                <td className="mono">{shortDate(o.issue_date || o.scheduled_send_date)}{!o.issue_date && o.scheduled_send_date ? <span className="cell-sub"> planned</span> : null}</td>
                <td className="mono">{shortDate(o.due_date)}</td>
                <td className="num">{money(o.total, o.currency)}</td>
                <td className="num">{o.sent_at ? money(o.amount_received, o.currency) : '—'}</td>
                <td><Badge status={o.status} /></td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  <a className="btn btn-ghost btn-sm" href={`/api/invoices/${o.id}/pdf/${o.invoice_number || o.next_number || o.id}.pdf?download=1`}>PDF</a>
                  {o.language === 'FR' && !o.is_legacy && <> <a className="btn btn-ghost btn-sm" href={`/api/invoices/${o.id}/docx`}>DOCX</a></>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
