import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { ApiError } from '../api';
import { Brand } from '../components/Brand';
import { Alert, Button } from '../components/ui';
import { pinProblem, type CodeSent } from '../services/onboarding';

/** Shared pieces of the member activation, sign-in and PIN-reset screens. */

export function AuthShell({ children, title, lead }: { children: ReactNode; title: string; lead: string }) {
  return (
    <div className="auth">
      <aside className="auth-side">
        <Link to="/" style={{ color: 'inherit' }}><Brand /></Link>
        <div className="hide-sm"><h2>{title}</h2><p>{lead}</p></div>
        <span />
      </aside>
      <main className="auth-main"><div className="auth-form ob">{children}</div></main>
    </div>
  );
}

export const STEPS = ['Confirm details', 'Verify phone', 'Create PIN', 'Complete'];
/** "Step 2 of 4" in words and as a bar: where the member is and what is left. */
export function Progress({ step, steps = STEPS }: { step: number; steps?: string[] }) {
  return (
    <ol className="ob-steps" aria-label={`Step ${step} of ${steps.length}: ${steps[step - 1]}`}>
      {steps.map((s, i) => (
        <li key={s} className={i + 1 < step ? 'done' : i + 1 === step ? 'here' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
          <span className="ob-dot" aria-hidden>{i + 1 < step ? <Check size={14} /> : i + 1}</span><span className="ob-name">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** A screen heading that takes focus when the step changes, so screen readers announce it. */
export function StepTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); window.scrollTo(0, 0); }, []);
  return <div><h1 ref={ref} tabIndex={-1} className="ob-title">{children}</h1>{sub && <p className="ob-sub">{sub}</p>}</div>;
}

/**
 * Enter the 6-digit code. One field (not six boxes) so Android can fill it straight from the SMS
 * and pasting works; the code is checked as soon as six digits are in.
 */
export function CodeEntry({ sent, onVerify, onResend, onChangeNumber }: {
  sent: CodeSent; onVerify: (code: string) => Promise<void>; onResend: () => Promise<CodeSent>; onChangeNumber?: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const [wait, setWait] = useState(sent.resendInSeconds);
  const [demoCode, setDemoCode] = useState(sent.demoCode);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);

  const verify = async (value = code) => {
    if (value.length !== 6 || busy) return;
    setBusy(true); setError(null); setNote(null);
    try { await onVerify(value); }
    catch (e: any) { setError(e.message); setCode(''); input.current?.focus(); if (e instanceof ApiError && e.code === 'OTP_EXPIRED') setWait(0); }
    finally { setBusy(false); }
  };
  const resend = async () => {
    setResending(true); setError(null); setNote(null);
    try { const s = await onResend(); setWait(s.resendInSeconds); setDemoCode(s.demoCode); setCode(''); setNote('We sent a new code. The old one no longer works.'); input.current?.focus(); }
    catch (e: any) { setError(e.message); if (e instanceof ApiError && e.details?.retryInSeconds) setWait(e.details.retryInSeconds); }
    finally { setResending(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); verify(); };

  return (
    <form onSubmit={submit} noValidate className="ob-form">
      {error && <Alert tone="bad">{error}</Alert>}
      {note && !error && <Alert tone="info">{note}</Alert>}
      <div className="field">
        <label htmlFor="otp">6-digit code</label>
        <input id="otp" ref={input} className="input otp-input" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} autoFocus
          aria-invalid={!!error} placeholder="••••••" value={code}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) verify(v); }} />
      </div>
      {demoCode && <p className="demo-code">Demo: no SMS is sent yet. Your code is <b>{demoCode}</b></p>}
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={code.length !== 6}>Verify</Button>
      <div className="ob-resend">
        <span>Didn’t receive the code?</span>
        {wait > 0 ? <span className="muted" aria-live="off">Resend code in {wait}s</span>
          : <button type="button" className="link-btn" disabled={resending} onClick={resend}>{resending ? 'Sending…' : 'Resend code'}</button>}
      </div>
      {onChangeNumber && <button type="button" className="link-btn ob-alt" onClick={onChangeNumber}>Use a different phone number</button>}
    </form>
  );
}

/** Choose and confirm a 4-digit PIN. The PIN is never shown. */
export function PinFields({ pin, pin2, onPin, onPin2 }: { pin: string; pin2: string; onPin: (v: string) => void; onPin2: (v: string) => void }) {
  const weak = pin.length === 4 ? pinProblem(pin) : null;
  const mismatch = pin2.length === 4 && pin.length === 4 && pin !== pin2;
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4);
  const done = pin2.length === 4 && pin === pin2 && !weak;
  const msg = weak ?? (mismatch ? 'The two PINs do not match. Enter the same 4 digits in both boxes.' : done ? 'The PINs match.' : 'Choose 4 digits you will remember. Avoid 1234 or your birth year.');
  // Side by side so the button stays in view above the keyboard.
  return (
    <div className="pin-pair">
      <div className="field">
        <label htmlFor="pin-new">Enter 4-digit PIN</label>
        <input id="pin-new" className="input pin-input" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" maxLength={4} autoFocus aria-invalid={!!weak} aria-describedby="pin-msg" value={pin} onChange={(e) => onPin(digits(e.target.value))} />
      </div>
      <div className="field">
        <label htmlFor="pin-confirm">Confirm PIN</label>
        <input id="pin-confirm" className="input pin-input" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" maxLength={4} aria-invalid={mismatch} aria-describedby="pin-msg" value={pin2} onChange={(e) => onPin2(digits(e.target.value))} />
      </div>
      <small id="pin-msg" className={`field-msg ${weak || mismatch ? 'err' : done ? 'ok' : ''}`} role={weak || mismatch ? 'alert' : 'status'}>{msg}</small>
    </div>
  );
}
export const pinsReady = (pin: string, pin2: string) => pin.length === 4 && pin === pin2 && !pinProblem(pin);
