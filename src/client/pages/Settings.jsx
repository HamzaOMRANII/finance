import { api, useApi, dateTime } from '../lib.js';
import { PageHead, Badge, Loading, Field, Input, FormError, useForm, useToast } from '../ui.jsx';

export default function Settings({ meta }) {
  const [s, reload] = useApi('/settings');
  if (!s) return <Loading />;
  return (
    <>
      <PageHead title="Settings" lead={`Notifications go to ${meta.owner_email || '(OWNER_EMAIL not set)'} · SMTP ${meta.smtp_configured ? 'configured' : 'NOT configured'} · receipts AI ${meta.receipts_ai ? 'on' : 'off'}`} />
      <div className="grid-2">
        <Rates rates={s.fx_rates} onSaved={reload} />
        <Password />
      </div>
      <TestEmail onSent={reload} />
      <section>
        <div className="panel-title"><h2>Automation runs</h2><span className="hint">latest 30</span></div>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Job</th><th>For</th><th>Mode</th><th>Result</th><th>Started</th></tr></thead>
          <tbody>{s.job_runs.map((r) => (
            <tr key={r.id}><td className="mono">{r.job}</td><td className="mono">{r.run_date}</td><td>{r.dry_run ? <Badge tone="b-dim">dry run</Badge> : <Badge tone="b-violet">live</Badge>}</td>
              <td>{r.ok === 1 ? <Badge tone="b-ok">ok</Badge> : r.ok === 0 ? <Badge tone="b-bad">failed</Badge> : <Badge tone="b-warn">running</Badge>} <span className="muted">{r.summary}</span></td>
              <td className="muted">{dateTime(r.started_at)}</td></tr>
          ))}{!s.job_runs.length && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}</tbody>
        </table></div>
      </section>
      <section>
        <div className="panel-title"><h2>Email log</h2><span className="hint">latest 30</span></div>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Kind</th><th>Subject</th><th>To</th><th>Status</th><th>When</th></tr></thead>
          <tbody>{s.email_log.map((m) => {
            const r = JSON.parse(m.recipients);
            return (
              <tr key={m.id}><td className="mono">{m.kind}</td><td>{m.subject}</td><td className="mono" style={{ fontSize: 12 }}>{r.to.join(', ')}{r.cc?.length ? ` · cc ${r.cc.join(', ')}` : ''}</td>
                <td>{m.status === 'sent' ? <Badge tone="b-ok">sent</Badge> : m.status === 'failed' ? <Badge tone="b-bad">failed</Badge> : <Badge tone="b-warn">pending</Badge>} {m.error && <span className="cell-sub">{m.error}</span>}</td>
                <td className="muted">{dateTime(m.sent_at || m.created_at)}</td></tr>
            );
          })}{!s.email_log.length && <tr><td colSpan={5} className="muted">No emails yet.</td></tr>}</tbody>
        </table></div>
      </section>
    </>
  );
}

function Rates({ rates, onSaved }) {
  const toast = useToast();
  const form = useForm({ USD: rates.USD ?? '', TND: rates.TND ?? '', VND: rates.VND ?? '' });
  const save = () => form.submit(async (v) => {
    await api('/settings/fx', { method: 'PUT', body: v });
    toast('Rates saved');
    onSaved();
  });
  return (
    <div className="panel stack">
      <div className="panel-title"><h2>Exchange rates</h2><span className="hint">EUR per 1 unit · updated {rates.updated || '—'}</span></div>
      <FormError form={form} />
      <div className="form">
        <Field label="1 USD in EUR"><Input form={form} name="USD" mono /></Field>
        <Field label="1 TND in EUR"><Input form={form} name="TND" mono /></Field>
        <Field label="1 VND in EUR"><Input form={form} name="VND" mono /></Field>
      </div>
      <div><button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={form.busy}>Save rates</button></div>
    </div>
  );
}

function Password() {
  const toast = useToast();
  const form = useForm({ current: '', next: '', confirm: '' });
  const save = () => form.submit(async (v) => {
    if (v.next !== v.confirm) throw new Error('the two new passwords differ');
    await api('/settings/password', { method: 'POST', body: v });
    toast('Password changed: sign in again');
    window.dispatchEvent(new Event('fintrack:logout'));
  });
  return (
    <div className="panel stack">
      <div className="panel-title"><h2>Password</h2><span className="hint">at least 12 characters</span></div>
      <FormError form={form} />
      <div className="form">
        <Field label="Current" full><Input form={form} name="current" type="password" autoComplete="current-password" /></Field>
        <Field label="New"><Input form={form} name="next" type="password" autoComplete="new-password" /></Field>
        <Field label="Repeat"><Input form={form} name="confirm" type="password" autoComplete="new-password" /></Field>
      </div>
      <div><button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={form.busy}>Change password</button></div>
    </div>
  );
}

function TestEmail({ onSent }) {
  const toast = useToast();
  const send = async () => {
    try {
      await api('/settings/test-email', { method: 'POST', body: {} });
      toast('Test email sent');
      onSent();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return <div><button type="button" className="btn btn-ghost btn-sm" onClick={send}>Send a test email to myself</button></div>;
}
