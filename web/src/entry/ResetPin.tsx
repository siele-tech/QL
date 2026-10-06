import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../auth';
import { Alert, Button } from '../components/ui';
import { memberAuth, type CodeSent } from '../services/onboarding';
import { AuthShell, CodeEntry, PinFields, Progress, StepTitle, pinsReady } from './Onboarding';

const SIDE = { title: 'Reset your PIN.', lead: 'Confirm who you are, verify your phone with a code, then choose a new PIN.' };
const STEPS = ['Confirm details', 'Verify phone', 'New PIN'];

/**
 * Forgot PIN. A member's phone may belong to a relative, so a code alone is not enough:
 * the National ID on the SACCO record is asked for as well.
 */
export function ResetPin() {
  const loc = useLocation() as any;
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [stage, setStage] = useState<'start' | 'pin' | 'code' | 'done'>('start');
  const [phone, setPhone] = useState<string>(loc.state?.phone ?? ''), [idNumber, setIdNumber] = useState('');
  const [pin, setPin] = useState(''), [pin2, setPin2] = useState('');
  const [sent, setSent] = useState<(CodeSent & { resetId: string }) | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const validPhone = /^(?:0|254)?[17]\d{8}$/.test(phone.replace(/\D/g, ''));

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try { setSent(await memberAuth.startPinReset(phone, idNumber)); setStage('pin'); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  if (stage === 'done') return (
    <AuthShell {...SIDE}>
      <div className="ob-done" role="status"><CheckCircle2 size={56} color="var(--good)" aria-hidden /><StepTitle sub="Use your new PIN the next time you sign in.">Your PIN has been changed</StepTitle></div>
      <Button variant="primary" size="lg" block onClick={async () => { if (signedIn) { await refresh(); nav('/member', { replace: true }); } else nav('/member/login', { replace: true }); }}>{signedIn ? 'Go to my QuickLoan' : 'Sign in'}</Button>
    </AuthShell>
  );

  return (
    <AuthShell {...SIDE}>
      <Link to="/member/login" className="small row ob-back"><ArrowLeft size={14} aria-hidden /> Back to sign in</Link>
      <Progress step={stage === 'start' ? 1 : stage === 'pin' ? 3 : 2} steps={STEPS} />
      {stage === 'start' && (
        <form onSubmit={start} noValidate className="ob-form">
          <StepTitle sub="Enter the phone number you use for QuickLoan and the National ID registered with your SACCO.">Forgot your PIN?</StepTitle>
          {error && <Alert tone="bad">{error}</Alert>}
          <div className="field"><label htmlFor="rp-phone">Phone number</label><input id="rp-phone" className="input ob-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" maxLength={16} value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label htmlFor="rp-id">National ID number</label><input id="rp-id" className="input ob-input" inputMode="numeric" autoComplete="off" maxLength={20} aria-describedby="rp-id-msg" value={idNumber} onChange={(e) => setIdNumber(e.target.value.replace(/[^\dA-Za-z]/g, ''))} /><small id="rp-id-msg" className="field-msg">We ask for this so that only you can change your PIN.</small></div>
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!validPhone || idNumber.length < 4}>Send code</Button>
        </form>
      )}
      {stage === 'pin' && (
        <form className="ob-form" noValidate onSubmit={(e) => { e.preventDefault(); if (pinsReady(pin, pin2)) setStage('code'); }}>
          <StepTitle sub="Choose the new PIN you will use to sign in.">Create a new PIN</StepTitle>
          <PinFields pin={pin} pin2={pin2} onPin={setPin} onPin2={setPin2} />
          <Button type="submit" variant="primary" size="lg" block disabled={!pinsReady(pin, pin2)}>Continue</Button>
        </form>
      )}
      {stage === 'code' && sent && (
        <>
          <StepTitle sub={<>If these details match an account, we’ve sent a verification code to <b>{sent.phone}</b>.</>}>Verify your phone</StepTitle>
          <CodeEntry sent={sent}
            onVerify={async (code) => { const r = await memberAuth.completePinReset(sent.resetId, code, pin); setSignedIn(r.signedIn); setStage('done'); }}
            onResend={() => memberAuth.resendPinReset(sent.resetId)} />
          <p className="fine center">No code? Check the phone number and National ID, or contact your SACCO.</p>
        </>
      )}
    </AuthShell>
  );
}
