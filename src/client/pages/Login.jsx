import { api } from '../lib.js';
import { Logo, Wordmark, useForm, Field, Input, FormError } from '../ui.jsx';

export default function Login({ onLogin }) {
  const form = useForm({ username: '', password: '' });
  const submit = (e) => {
    e.preventDefault();
    form.submit(async (v) => {
      await api('/login', { method: 'POST', body: v });
      await onLogin();
    });
  };
  return (
    <div className="login-wrap">
      <form className="login panel" onSubmit={submit}>
        <div className="brand">
          <Logo className="brand-mark" />
        </div>
        <div style={{ textAlign: 'center' }}><Wordmark /></div>
        <p className="domain">finance.omranisystems.com <span className="sep">/</span> sign in</p>
        <FormError form={form} />
        <Field label="Username"><Input form={form} name="username" autoComplete="username" autoFocus required /></Field>
        <Field label="Password"><Input form={form} name="password" type="password" autoComplete="current-password" required /></Field>
        <button className="btn btn-primary" type="submit" disabled={form.busy}>{form.busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
