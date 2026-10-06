import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, LinkIcon, Smartphone } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Alert, Button, SkeletonBlock, useData } from '../components/ui';
import { invitations, memberOnboarding, phoneVerification, type CodeSent, type IdentityResult } from '../services/onboarding';
import { AuthShell, CodeEntry, PinFields, Progress, StepTitle, pinsReady } from './Onboarding';

const SIDE = { title: 'Activate your QuickLoan account.', lead: 'Your SACCO already has your details. Confirm they are yours, verify the phone you use, and choose a PIN.' };
type Stage = 'details' | 'identity' | 'phone' | 'code' | 'pin' | 'done';
const STEP_OF: Record<Stage, number> = { details: 1, identity: 1, phone: 2, code: 2, pin: 3, done: 4 };

/**
 * Activation by personal invitation. The member confirms who they are (SACCO record + National ID)
 * and separately proves access to a phone (a code by SMS). The two are never mixed: the phone may
 * be a different number from the SACCO record and may be registered in a relative's name.
 */
export function Activate() {
  const { token = '' } = useParams();
  const q = useData(() => invitations.get(token), [token]);
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [stage, setStage] = useState<Stage>('details');
  const [identity, setIdentity] = useState<IdentityResult | null>(null);
  const [sent, setSent] = useState<CodeSent | null>(null);
  const [verified, setVerified] = useState<{ phone: string; isNewNumber: boolean } | null>(null);
  const [result, setResult] = useState<{ firstName: string; phoneUpdatePending: boolean } | null>(null);

  if (stage === 'done' && result) return (
    <AuthShell {...SIDE}>
      <Progress step={4} />
      <div className="ob-done" role="status">
        <CheckCircle2 size={56} color="var(--good)" aria-hidden />
        <StepTitle sub="Your QuickLoan account has been activated.">You’re all set! 🎉</StepTitle>
      </div>
      {result.phoneUpdatePending && <Alert tone="info">You are using a different number from the one on your SACCO record. You can use it for QuickLoan now; your SACCO will confirm the update to their records.</Alert>}
      <Button variant="primary" size="lg" block onClick={async () => { await refresh(); nav('/member', { replace: true }); }}>Go to my QuickLoan</Button>
    </AuthShell>
  );

  if (q.loading) return <AuthShell {...SIDE}><SkeletonBlock rows={4} /></AuthShell>;
  if (q.error || !q.data) return <InvitationProblem error={q.error} onRetry={() => q.reload()} />;
  const d = q.data;
  /** If the 30-minute verification window lapses mid-way, go back to the ID step with a clear reason. */
  const guard = (e: any) => { if (e instanceof ApiError && e.code === 'IDENTITY_NOT_VERIFIED') { setIdentity(null); setStage('identity'); } throw e; };

  return (
    <AuthShell {...SIDE}>
      <Progress step={STEP_OF[stage]} />
      {stage === 'details' && (
        <>
          <StepTitle sub={<>You’ve been invited by <b>{d.organization}</b> to access QuickLoan.</>}>Activate your QuickLoan account</StepTitle>
          <dl className="ob-card">
            <div><dt>Full name</dt><dd>{d.fullName}</dd></div>
            <div><dt>National ID</dt><dd>{d.idNumberMasked}</dd></div>
            <div><dt>SACCO</dt><dd>{d.organization}</dd></div>
          </dl>
          <p className="ob-note">Please confirm that these details belong to you. They come from your SACCO’s member register and cannot be changed here.</p>
          <Button variant="primary" size="lg" block onClick={() => setStage('identity')}>Confirm &amp; Continue</Button>
          <p className="fine center">Not you? Do not continue. Contact {d.organization}.</p>
        </>
      )}
      {stage === 'identity' && <IdentityStep token={token} onBack={() => setStage('details')} onVerified={(r) => { setIdentity(r); setStage('phone'); }} />}
      {stage === 'phone' && identity && (
        <PhoneStep recorded={identity.recordedPhone}
          send={(phone) => (phone === null ? phoneVerification.useRecorded(token, identity.activationToken) : phoneVerification.useNumber(token, identity.activationToken, phone)).catch(guard)}
          onSent={(s) => { setSent(s); setStage('code'); }} />
      )}
      {stage === 'code' && identity && sent && (
        <>
          <StepTitle sub={<>We’ve sent a verification code to <b>{sent.phone}</b>.</>}>Verify your phone</StepTitle>
          <CodeEntry sent={sent}
            onVerify={async (code) => { const v = await phoneVerification.verify(token, identity.activationToken, code).catch(guard); setVerified(v); setStage('pin'); }}
            onResend={() => phoneVerification.resend(token, identity.activationToken).catch(guard)}
            onChangeNumber={() => setStage('phone')} />
          <p className="fine center">The code confirms you can use this phone. It expires in {Math.round(sent.expiresInSeconds / 60)} minutes.</p>
        </>
      )}
      {stage === 'pin' && identity && verified && (
        <PinStep verified={verified}
          activate={(pin, crbConsent) => memberOnboarding.activate(token, identity.activationToken, pin, { crbConsent }).catch(guard)}
          onDone={(r) => { setResult(r); setStage('done'); }} />
      )}
    </AuthShell>
  );
}

function IdentityStep({ token, onVerified, onBack }: { token: string; onVerified: (r: IdentityResult) => void; onBack: () => void }) {
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try { onVerified(await memberOnboarding.verifyIdentity(token, id)); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate className="ob-form">
      <StepTitle sub="Enter the National ID registered with your SACCO.">Verify your identity</StepTitle>
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="field">
        <label htmlFor="nid">National ID number</label>
        <input id="nid" className="input ob-input" inputMode="numeric" autoComplete="off" autoFocus maxLength={20} aria-invalid={!!error} aria-describedby="nid-msg" value={id} onChange={(e) => setId(e.target.value.replace(/[^\dA-Za-z]/g, ''))} />
        <small id="nid-msg" className="field-msg">We ask for this to make sure only you can activate your account.</small>
      </div>
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={id.length < 4}>Continue</Button>
      <button type="button" className="link-btn ob-alt" onClick={onBack}>Back</button>
    </form>
  );
}

/** `send(null)` uses the number on the SACCO record; `send(phone)` uses the one the member typed. */
function PhoneStep({ recorded, send, onSent }: { recorded: string | null; send: (phone: string | null) => Promise<CodeSent>; onSent: (s: CodeSent) => void }) {
  const [other, setOther] = useState(!recorded);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<'recorded' | 'other' | null>(null);
  const go = async (which: 'recorded' | 'other') => {
    if (busy) return;
    setBusy(which); setError(null);
    try { onSent(await send(which === 'recorded' ? null : phone)); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const valid = /^(?:0|254)?[17]\d{8}$/.test(phone.replace(/\D/g, ''));

  if (!other) return (
    <div className="ob-form">
      <StepTitle sub="Is this the phone number you use?">Confirm your phone number</StepTitle>
      {error && <Alert tone="bad">{error}</Alert>}
      <dl className="ob-card"><div><dt>Phone number on your SACCO record</dt><dd className="ob-phone"><Smartphone size={18} aria-hidden /> {recorded}</dd></div></dl>
      <p className="ob-note">We’ll send a verification code to this number.</p>
      <Button variant="primary" size="lg" block loading={busy === 'recorded'} onClick={() => go('recorded')}>Yes, use this number</Button>
      <Button variant="outline" size="lg" block disabled={!!busy} onClick={() => { setOther(true); setError(null); }}>This isn’t my number</Button>
    </div>
  );
  return (
    <form className="ob-form" noValidate onSubmit={(e) => { e.preventDefault(); if (valid) go('other'); }}>
      <StepTitle sub="We’ll send a verification code to this number.">Which phone number do you currently use?</StepTitle>
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="field">
        <label htmlFor="ph">Phone number</label>
        <input id="ph" className="input ob-input" type="tel" inputMode="tel" autoComplete="tel" autoFocus placeholder="07XX XXX XXX" maxLength={16} aria-describedby="ph-msg" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <small id="ph-msg" className="field-msg">Your phone number may be different from the number registered with your SACCO. We’ll verify that you have access to this number using an OTP.</small>
      </div>
      <Button type="submit" variant="primary" size="lg" block loading={busy === 'other'} disabled={!valid}>Send code</Button>
      {recorded && <button type="button" className="link-btn ob-alt" onClick={() => { setOther(false); setError(null); }}>Use the number on my SACCO record ({recorded})</button>}
    </form>
  );
}

function PinStep({ verified, activate, onDone }: { verified: { phone: string; isNewNumber: boolean }; activate: (pin: string, crbConsent: boolean) => Promise<{ firstName: string; phoneUpdatePending: boolean }>; onDone: (r: { firstName: string; phoneUpdatePending: boolean }) => void }) {
  const [pin, setPin] = useState(''), [pin2, setPin2] = useState('');
  const [agree, setAgree] = useState(false), [crb, setCrb] = useState(true);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !pinsReady(pin, pin2) || !agree) return;
    setBusy(true); setError(null);
    try { onDone(await activate(pin, crb)); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate className="ob-form">
      <StepTitle sub="Your PIN will be used to securely access your account.">Create your QuickLoan PIN</StepTitle>
      <p className="ob-ok" role="status"><CheckCircle2 size={18} aria-hidden /> <span><b>Phone number verified.</b> You can now use {verified.phone} to access your QuickLoan account.</span></p>
      {error && <Alert tone="bad">{error}</Alert>}
      <PinFields pin={pin} pin2={pin2} onPin={setPin} onPin2={setPin2} />
      <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> <span>I accept the QuickLoan terms and allow my SACCO to use my details to provide loans.</span></label>
      <label className="check"><input type="checkbox" checked={crb} onChange={(e) => setCrb(e.target.checked)} /> <span>I allow my SACCO to check my credit bureau (CRB) record when I apply. <span className="muted">Optional.</span></span></label>
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!pinsReady(pin, pin2) || !agree}>Activate Account</Button>
    </form>
  );
}

/** The link is missing, wrong, expired or already used. Say which, and what to do next. */
function InvitationProblem({ error, onRetry }: { error: ApiError | null; onRetry: () => void }) {
  const code = error?.code;
  const used = code === 'INVITATION_USED';
  const network = !code || ['NETWORK', 'TIMEOUT', 'OFFLINE', 'INTERNAL'].includes(code);
  return (
    <AuthShell {...SIDE}>
      <div className="ob-done">
        <LinkIcon size={44} color={used ? 'var(--teal)' : 'var(--warn)'} aria-hidden />
        <StepTitle sub={error?.message}>{used ? 'Your account is already active' : code === 'INVITATION_EXPIRED' ? 'This link has expired' : network ? 'We couldn’t open your invitation' : 'This link is not valid'}</StepTitle>
      </div>
      {network ? <Button variant="primary" size="lg" block onClick={onRetry}>Try again</Button>
        : <Link to="/member/login" className={`btn btn-${used ? 'primary' : 'outline'} btn-lg btn-block`}>{used ? 'Sign in' : 'Go to sign in'}</Link>}
    </AuthShell>
  );
}

/** /member/activate with no token: activation always starts from the personal link. */
export function ActivateHelp() {
  const demo = useData(() => api.get('/public/demo'), []);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  // Demo only: stands in for the SMS link a SACCO sends.
  const openDemo = async () => { setBusy(true); try { nav((await invitations.demo()).link); } catch { setBusy(false); } };
  return (
    <AuthShell {...SIDE}>
      <div className="ob-done">
        <LinkIcon size={44} color="var(--teal)" aria-hidden />
        <StepTitle sub="Your SACCO sends you a personal link by SMS. Open that link on this phone to activate your account.">Use your invitation link</StepTitle>
      </div>
      <p className="ob-note">No link yet? Ask your SACCO to invite you to QuickLoan.</p>
      <Link to="/member/login" className="btn btn-outline btn-lg btn-block">I already have an account</Link>
      {demo.data?.enabled && <div className="demo-box"><b>Demo</b><Button variant="teal" block loading={busy} onClick={openDemo}>Open {demo.data.accounts.onboarding.name}’s invitation link</Button><span className="demo-note">National ID for the demo: {demo.data.accounts.onboarding.idNumber}</span></div>}
    </AuthShell>
  );
}
