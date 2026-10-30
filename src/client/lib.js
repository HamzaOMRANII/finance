// Client plumbing: the pathname router (same as it.omranisystems.com, plus query strings),
// the API wrapper (session cookie + CSRF header) and display helpers.
import { useCallback, useEffect, useState } from 'react';
import { formatMoney, fromMinor } from '../shared/money.mjs';
import { diffDays, today as todayLagos } from '../shared/dates.mjs';

// ---------- router
const current = () => window.location.pathname.replace(/\/+$/, '') || '/';

export const usePath = () => {
  const [path, setPath] = useState(current());
  const [search, setSearch] = useState(window.location.search);
  useEffect(() => {
    const onPop = () => {
      setPath(current());
      setSearch(window.location.search);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return { path, query: new URLSearchParams(search) };
};

export const navigate = (to) => {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
};

// onClick for internal <a href>: same-tab navigation without a reload.
export const go = (to) => (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(to);
};

// ---------- API
let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // the access gate answers with a cross-site redirect once its cookie expires
    throw new Error('Network error or access gate expired: reload the page.');
  }
  if (res.status === 401 && path !== '/session' && path !== '/login') window.dispatchEvent(new Event('fintrack:logout'));
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, fields: data.fields });
  return data;
}

// Sends a file as the raw request body (uploads). `path` may carry its own query string.
export async function upload(path, file) {
  const sep = path.includes('?') ? '&' : '?';
  let res;
  try {
    res = await fetch(`/api${path}${sep}name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
      body: file,
    });
  } catch {
    throw new Error('Network error or access gate expired: reload the page.');
  }
  if (res.status === 413) throw new Error('File too large (max 2 MB).');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Loads a GET endpoint; returns [data, reload, error].
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null });
  const load = useCallback(() => {
    if (!path) return;
    api(path).then((data) => setState({ data, error: null }), (error) => setState((s) => ({ data: s.data, error })));
  }, [path]);
  useEffect(load, [load]);
  return [state.data, load, state.error];
}

// ---------- formatting
export const money = (minor, currency) => formatMoney(minor, currency, 'EN');
export const decimal = (minor, currency) => (minor === null || minor === undefined ? '' : String(fromMinor(minor, currency)));
export const today = () => todayLagos();
export const daysFrom = (date) => diffDays(todayLagos(), date);

export function moneyMap(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return '—';
  return entries.map(([cur, minor]) => money(minor, cur)).join(' · ');
}

export function shortDate(date) {
  if (!date) return '—';
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
}

// ISO-2 -> emoji flag
export function flag(code) {
  if (!code || code === 'worldwide') return '🌍';
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export function countryName(code) {
  if (!code) return '';
  if (code === 'worldwide') return 'Worldwide';
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code); } catch { return code; }
}

export const STATUS_TONE = {
  upcoming: 'b-ok', paid: 'b-dim', overdue: 'b-bad', cancelled: 'b-dim',
  active: 'b-ok', standby: 'b-warn', blocked: 'b-bad', expired: 'b-dim',
  draft: 'b-dim', pending_approval: 'b-warn', approved: 'b-violet', sent: 'b-ok',
  partially_paid: 'b-warn', void: 'b-dim', scheduled: 'b-violet',
};
export const label = (s) => String(s || '').replace(/_/g, ' ');
