import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '../api';
import { Alert, Button, Card, Loadable, clearDataCache, useData } from '../components/ui';
import { fmtDate, kes } from '../format';
import { MTop } from './MemberApp';

/**
 * Apply in two screens: 1) choose the amount and see the cost update as you go,
 * 2) confirm the summary and terms. Nothing the lender already knows is asked again.
 */
export function Borrow() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const q = useData(() => Promise.all([api.get('/member/eligibility'), api.get('/member/profile')]), []);
  const [step, setStep] = useState<1 | 2>(1);
  const [productId, setProductId] = useState<string>(params.get('product') ?? '');
  const [amount, setAmount] = useState<number>(Number(params.get('amount')) || 0);
  const [quote, setQuote] = useState<any>(null);
  const [quoting, setQuoting] = useState(false);
  const [accept, setAccept] = useState(false);
  const [crb, setCrb] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const el = q.data?.[0], profile = q.data?.[1];
  const eligible = useMemo(() => (el?.products ?? []).filter((p: any) => p.eligible), [el]);
  const product = eligible.find((p: any) => p.id === productId) ?? eligible[0];
  const max = product ? Math.min(product.maxAmount, el.available) : 0;
  const min = product?.minAmount ?? 0;
  const stepSize = max - min >= 5000 ? 500 : 100;
  const crbOnFile = profile?.consents?.some((c: any) => c.type === 'CRB_CHECK');
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  useEffect(() => {
    if (!product) return;
    if (!productId) setProductId(product.id);
    if (!amount || amount > max || amount < min) setAmount(clamp(Math.round(max / 2 / stepSize) * stepSize));
  }, [product?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountError = !product ? null : amount < min ? `The smallest amount is ${kes(min)}.` : amount > max ? `You can borrow up to ${kes(max)}.` : null;

  // Live cost: recalculated by the lending engine shortly after the amount stops changing.
  useEffect(() => {
    if (!product || amountError) { setQuoting(false); return; }
    setQuoting(true);
    const t = setTimeout(() => {
      api.post('/member/quote', { productId: product.id, amount })
        .then((r) => { setQuote(r.quote); setError(null); })
        .catch((e) => setError(e.message))
        .finally(() => setQuoting(false));
    }, 350);
    return () => clearTimeout(t);
  }, [product?.id, amount, amountError]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const app = await api.post('/member/applications', { productId: product.id, amount, acceptTerms: accept, crbConsent: crb || !!crbOnFile, offerToken: params.get('offer') ?? undefined });
      clearDataCache();
      nav(`/member/applications/${app.id}`, { replace: true });
    } catch (e: any) { setError(e.message || 'We couldn’t submit your application. Please try again.'); window.scrollTo(0, 0); } finally { setBusy(false); }
  };
  const quoteReady = quote && quote.amount === amount && !amountError;
  const chips = product ? [...new Set([0.25, 0.5, 0.75, 1].map((f) => clamp(Math.round((max * f) / stepSize) * stepSize)))] : [];

  return (
    <>
      <MTop back={step === 1 ? '/member' : undefined} title={step === 1 ? 'Apply for a loan' : 'Confirm your loan'} right={<span className="small muted">Step {step} of 2</span>} />
      <div className="m-content m-narrow">
        <div className="wizard-dots" aria-hidden>{[1, 2].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>
        <Loadable q={q}>{() => !product ? (
          <Card><h2>No loan available right now</h2>{(el.blockers.length ? el.blockers : ['There is no loan offer for you at the moment.']).map((b: string) => <p key={b} className="small">{b}</p>)}<Button variant="outline" block onClick={() => nav('/member')}>Back to home</Button></Card>
        ) : (
          <>
            {error && <Alert tone="bad">{error}</Alert>}
            {step === 1 && (
              <>
                {eligible.length > 1 && (
                  <div className="field" style={{ margin: 0 }}>
                    <label id="lbl-loan">Loan and period</label>
                    <div className="tabs" role="group" aria-labelledby="lbl-loan">{eligible.map((p: any) => (
                      <button key={p.id} type="button" aria-pressed={p.id === product.id} className={p.id === product.id ? 'active' : ''} onClick={() => { setProductId(p.id); setAmount(Math.max(p.minAmount, Math.min(Math.min(p.maxAmount, el.available), amount))); }}>{p.name} · {p.periodDays} days</button>
                    ))}</div>
                  </div>
                )}
                <Card>
                  <label htmlFor="amount" className="row between small" style={{ marginBottom: '.6rem' }}><b style={{ fontFamily: 'var(--display)', color: 'var(--navy)' }}>How much do you need?</b><span className="muted">Up to {kes(max)}</span></label>
                  <div className="amount-row single">
                    <div className="amount-box"><span aria-hidden>KES</span><input id="amount" className="input amount-input" inputMode="numeric" pattern="[0-9,]*" autoComplete="off" value={amount ? amount.toLocaleString('en-KE') : ''} onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')) || 0)} aria-describedby="amount-help" /></div>
                  </div>
                  <input type="range" aria-label="Loan amount" min={min} max={max} step={stepSize} value={clamp(amount)} onChange={(e) => setAmount(Number(e.target.value))} />
                  <div className="chip-row">{chips.map((v) => <button key={v} type="button" className={`pick ${amount === v ? 'on' : ''}`} onClick={() => setAmount(v)}>{v === max ? 'Max' : kes(v).replace('KES ', '')}</button>)}</div>
                  <p id="amount-help" className={`small ${amountError ? 'text-bad' : 'muted'}`} role={amountError ? 'alert' : undefined} style={{ margin: '.6rem 0 0' }}>{amountError ?? 'Borrow only what you need.'}</p>
                </Card>
                <Card className={quoting ? 'is-updating' : ''}>
                  <dl className="kv" aria-live="polite">
                    <div><dt>Loan amount</dt><dd>{kes(amount)}</dd></div>
                    <div><dt>Loan period</dt><dd>{product.periodDays} days</dd></div>
                    <div><dt>Interest and fees</dt><dd>{quoteReady ? kes(quote.totalCost) : '…'}</dd></div>
                    <div className="total"><dt>Total repayment</dt><dd>{quoteReady ? kes(quote.totalRepayable) : '…'}</dd></div>
                    <div><dt>Due date</dt><dd>{quoteReady ? fmtDate(quote.dueDate) : '…'}</dd></div>
                  </dl>
                </Card>
                <Button variant="primary" size="lg" block disabled={!quoteReady} onClick={() => { setStep(2); window.scrollTo(0, 0); }}>Continue</Button>
              </>
            )}
            {step === 2 && quote && (
              <>
                <Card>
                  <p className="small muted" style={{ margin: '0 0 .3rem' }}>{product.name} from {profile.organization.name}</p>
                  <dl className="kv">
                    <div><dt>Loan amount</dt><dd>{kes(quote.amount)}</dd></div>
                    {quote.interest > 0 && <div><dt>Interest ({product.interestRateMonthly}% a month)</dt><dd>{kes(quote.interest)}</dd></div>}
                    {quote.fee > 0 && <div><dt>Fee</dt><dd>{kes(quote.fee)}</dd></div>}
                    {quote.totalCost === 0 && <div><dt>Interest and fees</dt><dd>{kes(0)}</dd></div>}
                    <div className="total"><dt>Total repayment</dt><dd>{kes(quote.totalRepayable)}</dd></div>
                    <div><dt>Due date</dt><dd>{fmtDate(quote.dueDate)}</dd></div>
                    <div><dt>Money sent to</dt><dd>M-PESA {profile.disbursementPhone}</dd></div>
                  </dl>
                </Card>
                <Card title="If you pay late">
                  <ul className="plain-list">
                    <li>{product.lateFeeText ? <>Late fee: <b>{product.lateFeeText}</b>.</> : 'There is no late fee, but late payment is recorded.'}</li>
                    <li>{product.rolloverEnabled ? (product.rolloverMode === 'AUTOMATIC' ? `If unpaid, the loan is rolled over automatically (${product.rolloverFeePct}% fee, up to ${product.rolloverMax} times).` : `You may pay a ${product.rolloverFeePct}% rollover fee to move the due date by ${product.rolloverPeriodDays} days, up to ${product.rolloverMax} times.`) : 'This loan cannot be rolled over.'}</li>
                    <li>Late payment lowers your loan behaviour score and may be reported to credit reference bureaus.</li>
                  </ul>
                  {(product.earlyRepaymentEnabled || product.allowPartial) && <p className="fine" style={{ margin: '.6rem 0 0' }}>{product.allowPartial ? 'You can pay in parts at any time. ' : ''}{product.earlyRepaymentEnabled ? `Repay early and get back ${product.earlyRepaymentRebatePct}% of the unused interest.` : ''}</p>}
                </Card>
                <label className="check"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> <span>I understand the total repayment, the due date and what happens if I pay late, and I accept these terms.</span></label>
                {crbOnFile ? <p className="fine"><ShieldCheck size={12} style={{ verticalAlign: -1 }} aria-hidden /> Your consent for credit bureau checks is on file.</p> : (
                  <label className="check"><input type="checkbox" checked={crb} onChange={(e) => setCrb(e.target.checked)} /> <span>I allow {profile.organization.name} to check my credit bureau (CRB) record for this application.</span></label>
                )}
                <Button variant="primary" size="lg" block loading={busy} disabled={!accept || (!crbOnFile && !crb)} onClick={apply}>Apply for {kes(quote.amount)}</Button>
                <Button variant="outline" block onClick={() => { setStep(1); window.scrollTo(0, 0); }}>Change amount</Button>
              </>
            )}
          </>
        )}</Loadable>
      </div>
    </>
  );
}

const FLOW = [
  { key: 'APPLIED', label: 'Submitted' }, { key: 'UNDER_REVIEW', label: 'Under review' }, { key: 'APPROVED', label: 'Approved' },
  { key: 'DISBURSING', label: 'Sending to M-PESA' }, { key: 'DISBURSED', label: 'Money sent' },
];

export function ApplicationStatus() {
  const { id } = useParams();
  const nav = useNavigate();
  const q = useData(() => api.get(`/member/applications/${id}`), [id]);
  const a = q.data;
  const live = a && ['APPLIED', 'UNDER_REVIEW', 'APPROVED', 'DISBURSING'].includes(a.status);
  const waitingOnLender = a && a.approvalMode === 'MANUAL' && ['APPLIED', 'UNDER_REVIEW'].includes(a.status);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => q.reload(true), waitingOnLender ? 6000 : 1500);
    return () => clearInterval(t);
  }, [live, waitingOnLender]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <MTop back="/member" title="Application status" />
      <div className="m-content m-narrow">
        <Loadable q={q}>{(a) => {
          const idx = FLOW.findIndex((f) => f.key === a.status);
          const rejected = a.status === 'REJECTED', failed = a.status === 'DISBURSEMENT_FAILED', done = a.status === 'DISBURSED';
          return (
            <>
              <div className="center" style={{ padding: '.5rem 0' }}>
                {done ? <CheckCircle2 size={48} color="var(--good)" aria-hidden /> : rejected || failed ? <XCircle size={48} color="var(--terracotta)" aria-hidden /> : waitingOnLender ? <Clock size={48} color="var(--warn)" aria-hidden /> : <div className="spin big-spinner" aria-hidden />}
                <h2 style={{ marginTop: '.6rem', fontSize: '1.4rem' }} role="status">{done ? 'Money sent' : rejected ? 'Application not approved' : failed ? 'Payout delayed' : waitingOnLender ? 'Waiting for your lender' : 'Application submitted'}</h2>
                <p className="muted small" style={{ margin: 0 }}>{a.productName} · {kes(a.amount)} · Ref {a.reference}</p>
              </div>
              {waitingOnLender && <Alert tone="warn">Your lender reviews this loan before approving it. You will get an SMS as soon as there is a decision. You can close this screen.</Alert>}
              {rejected && <Alert tone="bad">{a.decisionReason ?? 'Your lender was unable to approve this application.'}</Alert>}
              {failed && <Alert tone="warn">We could not send the money to M-PESA yet. Your lender has been told and will retry.</Alert>}
              <Card>
                <ol className="steps">
                  {FLOW.map((f, i) => {
                    const cls = rejected ? (i === 0 ? 'done' : i === 1 ? 'bad' : '') : done || i < idx ? 'done' : i === idx ? 'current' : '';
                    const at = a.history.find((h: any) => h.to === f.key)?.at;
                    return <li key={f.key} className={cls} aria-current={cls === 'current' ? 'step' : undefined}><span className="sdot" aria-hidden />{rejected && i === 1 ? 'Not approved' : f.label}{at && <small>{fmtDate(at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>}</li>;
                  })}
                </ol>
              </Card>
              <Card><dl className="kv"><div><dt>Loan amount</dt><dd>{kes(a.amount)}</dd></div><div className="total"><dt>Total repayment</dt><dd>{kes(a.totalRepayable)}</dd></div><div><dt>Loan period</dt><dd>{a.periodDays} days</dd></div></dl></Card>
              {a.loanId ? <Button variant="primary" size="lg" block onClick={() => nav(`/member/loans/${a.loanId}`)}>View my loan</Button>
                : <Button variant={rejected ? 'primary' : 'outline'} size="lg" block onClick={() => nav('/member')}>Back to home</Button>}
            </>
          );
        }}</Loadable>
      </div>
    </>
  );
}
