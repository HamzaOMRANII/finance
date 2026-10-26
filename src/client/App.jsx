import { useEffect, useState } from 'react';
import { api, setCsrf, usePath, go } from './lib.js';
import { Logo, Wordmark, Orbs, ToastProvider, Loading } from './ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Bills from './pages/Bills.jsx';
import Cards from './pages/Cards.jsx';
import Receipts from './pages/Receipts.jsx';
import Clients, { ClientDetail } from './pages/Clients.jsx';
import Issuers from './pages/Issuers.jsx';
import Schedules from './pages/Schedules.jsx';
import Invoices from './pages/Invoices.jsx';
import InvoiceEditor from './pages/InvoiceEditor.jsx';
import Approvals from './pages/Approvals.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  ['/', 'Dashboard'],
  ['/bills', 'Bills'],
  ['/cards', 'Cards'],
  ['/receipts', 'Receipts'],
  ['/invoices', 'Invoices'],
  ['/approvals', 'Approvals'],
  ['/clients', 'Clients'],
  ['/schedules', 'Schedules'],
  ['/issuers', 'Issuers'],
  ['/settings', 'Settings'],
];

function route(path) {
  if (path === '/') return [Dashboard];
  const m = path.match(/^\/(\w+)(?:\/([\w-]+))?$/);
  if (!m) return [null];
  const [, section, id] = m;
  if (section === 'invoices' && id) return [InvoiceEditor, { id }];
  if (section === 'clients' && id) return [ClientDetail, { id }];
  const pages = { bills: Bills, cards: Cards, receipts: Receipts, invoices: Invoices, approvals: Approvals, clients: Clients, schedules: Schedules, issuers: Issuers, settings: Settings };
  return [id ? null : pages[section] || null];
}

export default function App() {
  const { path, query } = usePath();
  const [session, setSession] = useState(undefined);
  const [pending, setPending] = useState(0);

  const loadSession = () => api('/session').then((s) => { setCsrf(s.csrf); setSession(s); }, () => setSession(null));
  useEffect(() => { loadSession(); }, []);
  useEffect(() => {
    const out = () => setSession(null);
    window.addEventListener('fintrack:logout', out);
    return () => window.removeEventListener('fintrack:logout', out);
  }, []);
  // approval counter in the nav, refreshed on navigation
  useEffect(() => {
    if (session) api('/approvals').then((rows) => setPending(rows.filter((r) => r.status === 'pending_approval').length), () => {});
  }, [session, path]);

  if (session === undefined) return <><Orbs /><Loading /></>;
  if (!session) return <ToastProvider><Orbs /><Login onLogin={loadSession} /></ToastProvider>;

  const [Page, props] = route(path);
  const logout = async () => {
    await api('/logout', { method: 'POST', body: {} }).catch(() => {});
    setSession(null);
  };
  const active = (to) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));

  return (
    <ToastProvider>
      <Orbs />
      <div className="app">
        <header className="topbar">
          <a className="brand" href="/" onClick={go('/')}>
            <Logo className="brand-mark" />
            <Wordmark />
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map(([to, text]) => (
              <a key={to} href={to} onClick={go(to)} className={active(to) ? 'active' : undefined} aria-current={active(to) ? 'page' : undefined}>
                {text}{to === '/approvals' && pending > 0 && <span className="count">{pending}</span>}
              </a>
            ))}
          </nav>
          <div className="user">
            <span className="who">{session.username}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>Log out</button>
          </div>
        </header>
        <main className="page-app">
          {Page ? <Page {...props} query={query} meta={session.meta} /> : <div className="empty">Page not found. <a href="/" onClick={go('/')}>Dashboard</a></div>}
        </main>
        <footer className="footer">
          <span className="domain">finance.omranisystems.com</span> <span className="sep">/</span> &copy; {new Date().getFullYear()} Hamza Omrani LLC
        </footer>
      </div>
    </ToastProvider>
  );
}
