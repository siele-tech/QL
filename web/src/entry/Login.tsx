import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../api';
import { memberAuth } from '../services/onboarding';
import { useAuth } from '../auth';
import { Brand } from '../components/Brand';
import { Alert, Button, Field, Input, Select, useData } from '../components/ui';

function useAfterLogin() {
  const nav = useNavigate();
  const loc = useLocation() as any;
  const { refresh } = useAuth();
  return async () => {
    await refresh();
    const from: string | undefined = loc.state?.from;
    nav(from && from.startsWith('/member') ? from : '/member', { replace: true });
  };
}

export function MemberLogin() {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [orgs, setOrgs] = useState<{ id: string; name: string }[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const after = useAfterLogin();
  const demo = useData(() => api.get('/public/demo'), []);

  const submit = async (e?: FormEvent, p = phone, n = pin) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      await memberAuth.login(p, n, orgId || undefined);
      await after();
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'CHOOSE_ORGANIZATION') setOrgs(err.details.organizations);
      setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="auth">
      <aside className="auth-side">
        <Link to="/" style={{ color: 'inherit' }}><Brand /></Link>
        <div className="hide-sm">
          <h2>Borrow with confidence.</h2>
          <p>See your limit, the full cost and your due date before you borrow. Repay by M-PESA, anytime.</p>
        </div>
        <span className="small hide-sm" style={{ opacity: .7 }}>Loans are provided by your SACCO, MFI or credit group.</span>
      </aside>
      <main className="auth-main">
        <form className="auth-form ob" onSubmit={submit} noValidate>
          <Link to="/" className="small row"><ArrowLeft size={14} /> Back</Link>
          <div><h1 className="ob-title">Welcome back</h1><p className="ob-sub">Sign in with the phone number and PIN you set up for QuickLoan.</p></div>
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="Phone number" htmlFor="phone">
            <Input id="phone" className="ob-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </Field>
          <Field label="PIN" htmlFor="pin">
            <Input id="pin" className="pin-input" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="current-password" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
          </Field>
          {orgs && (
            <Field label="Organization">
              <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                <option value="">Choose…</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </Field>
          )}
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!phone || pin.length !== 4}>Sign in</Button>
          <p className="center" style={{ margin: 0 }}><Link to="/member/reset-pin" state={{ phone }}>Forgot PIN?</Link></p>
          {demo.data?.enabled && (
            <div className="demo-box">
              <b>Demo members</b> <span className="demo-note">(tap to sign in, PIN 1234)</span>
              {[demo.data.accounts.member, ...demo.data.accounts.otherMembers].map((a: any) => (
                <button type="button" key={a.phone} onClick={() => { setPhone(a.phone); setPin(a.pin); submit(undefined, a.phone, a.pin); }}>
                  {a.name} · {a.phone} <span className="demo-note">— {a.note}</span>
                </button>
              ))}
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
