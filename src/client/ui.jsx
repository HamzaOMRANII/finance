// Shared UI pieces: logo, page header, badges, money, modal, form fields, toasts.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { STATUS_TONE, label, flag, countryName, money, go } from './lib.js';

// The omranisystems mark, FinTrack edition: petrol S, gold badge with a rising line.
// Same geometry and mask as the IT logo; the PDF invoices draw the same shape.
export function Logo({ className }) {
  return (
    <svg className={className} viewBox="4 4 124 124" role="img" aria-label="FinTrack Omrani Systems logo">
      <mask id="fin-cut" maskUnits="userSpaceOnUse" x="4" y="4" width="124" height="124">
        <rect x="4" y="4" width="124" height="124" fill="#fff" />
        <path d="M116 32H52Q40 32 40 44V48Q40 60 52 60H68Q80 60 80 72V76Q80 88 68 88H4" fill="none" stroke="#000" strokeWidth="21" />
        <circle cx="100" cy="100" r="21.5" fill="#000" />
      </mask>
      <circle cx="60" cy="60" r="46" fill="none" stroke="#FFFFFF" strokeWidth="9" mask="url(#fin-cut)" />
      <path d="M102 32H52Q40 32 40 44V48Q40 60 52 60H68Q80 60 80 72V76Q80 88 68 88H18" fill="none" stroke="var(--petrol-bright)" strokeWidth="11" />
      <circle cx="100" cy="100" r="19" fill="var(--gold)" />
      <path d="M88 108L96 100L102 105L112 93M105 93H112V100" fill="none" stroke="var(--navy-900)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="w-app">finance</span>
      <span>omrani</span>
      <span className="w-light">systems</span>
    </span>
  );
}

export function Orbs() {
  return (
    <div className="bg-field" aria-hidden="true">
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="noise" />
    </div>
  );
}

export function PageHead({ title, lead, back, children }) {
  return (
    <div className="page-head">
      <div>
        {back && <a className="back" href={back} onClick={go(back)}>&larr; Back</a>}
        <h1 className="page-title">{title}</h1>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function Badge({ status, children, tone }) {
  return <span className={`badge ${tone || STATUS_TONE[status] || 'b-dim'}`}>{children || label(status)}</span>;
}

export function Money({ minor, currency, muted }) {
  if (minor === null || minor === undefined) return <span className="muted">TODO</span>;
  return <span className={muted ? 'muted' : undefined}>{money(minor, currency)}</span>;
}

export function Flag({ code, withName }) {
  if (!code) return null;
  return (
    <span title={countryName(code)}>
      <span className="flag">{flag(code)}</span> {withName ? countryName(code) : <span className="cc">{code === 'worldwide' ? '' : code}</span>}
    </span>
  );
}

export function Days({ n }) {
  if (n === null || n === undefined) return null;
  const tone = n < 0 ? 'bad' : n <= 7 ? 'warn' : 'ok';
  const text = n < 0 ? `${-n}d late` : n === 0 ? 'today' : `in ${n}d`;
  return <span className={`days ${tone}`}>{text}</span>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="loading">loading…</div>;
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="x" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- form fields bound to a values object
export function Field({ label: text, help, error, full, children }) {
  return (
    <label className={`field${full ? ' full' : ''}${error ? ' has-err' : ''}`}>
      <span>{text}{help && <span className="help"> · {help}</span>}</span>
      {children}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (name) => (e) => {
    const v = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setValues((s) => ({ ...s, [name]: v }));
  };
  // runs fn(values); maps API field errors back onto inputs
  const submit = async (fn) => {
    setBusy(true);
    setError('');
    setErrors({});
    try {
      return await fn(values);
    } catch (err) {
      setError(err.message);
      setErrors(err.fields || {});
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { values, setValues, set, errors, error, busy, submit };
}

export function Input({ form, name, type = 'text', mono, ...rest }) {
  return (
    <input className={`input${mono ? ' mono' : ''}`} type={type} value={form.values[name] ?? ''} onChange={form.set(name)} {...rest} />
  );
}

export function Select({ form, name, options, empty, ...rest }) {
  return (
    <select className="select" value={form.values[name] ?? ''} onChange={form.set(name)} {...rest}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => (Array.isArray(o)
        ? <option key={o[0]} value={o[0]}>{o[1]}</option>
        : <option key={o} value={o}>{label(o)}</option>))}
    </select>
  );
}

export function Textarea({ form, name, ...rest }) {
  return <textarea className="textarea" value={form.values[name] ?? ''} onChange={form.set(name)} {...rest} />;
}

export function Check({ form, name, children }) {
  return (
    <label className="check">
      <input type="checkbox" checked={!!form.values[name]} onChange={form.set(name)} /> {children}
    </label>
  );
}

export function FormError({ form }) {
  return form.error ? <div className="form-error">{form.error}</div> : null;
}

// ---------- toasts
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random();
    setItems((s) => [...s, { id, text, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// Button that asks before doing something irreversible.
export function ConfirmButton({ confirm, onConfirm, className = 'btn btn-ghost btn-sm', children, disabled }) {
  return (
    <button type="button" className={className} disabled={disabled}
      onClick={() => { if (window.confirm(confirm)) onConfirm(); }}>
      {children}
    </button>
  );
}

// File picker shown as a button ("Upload & analyse"). Calls onFile(file) once a file is chosen.
export function UploadButton({ label = 'Upload', busyLabel = 'Uploading…', onFile, busy, className = 'btn btn-primary', accept = '.pdf,.png,.jpg,.jpeg,.webp' }) {
  const ref = useRef(null);
  return (
    <>
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      <button type="button" className={className} onClick={() => ref.current?.click()} disabled={busy}>{busy ? busyLabel : label}</button>
    </>
  );
}
