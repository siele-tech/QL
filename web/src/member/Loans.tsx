import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Download, Loader2, Smartphone, Wallet, XCircle } from 'lucide-react';
import { api, downloadFile } from '../api';
import { Alert, Badge, Button, Card, EmptyState, KeyValue, Loadable, Modal, ProgressBar, Tabs, clearDataCache, useData, useToast } from '../components/ui';
import { CHANNEL, PAYMENT_TYPE, fmtDate, kes, monthYear, plural, shortDate } from '../format';
import { MTop } from './MemberApp';
import { CurrentLoanHero } from './Home';

const OPEN = ['ACTIVE', 'DUE', 'OVERDUE', 'ROLLED_OVER', 'DEFAULTED'];
const IN_PROGRESS = ['APPLIED', 'UNDER_REVIEW', 'APPROVED', 'DISBURSING', 'DISBURSEMENT_FAILED'];
const isOverdue = (l: any) => OPEN.includes(l.status) && (l.daysOverdue > 0 || ['OVERDUE', 'DEFAULTED'].includes(l.status));
type LoanTab = 'active' | 'pending' | 'completed' | 'overdue';

export function LoansPage() {
  const q = useData(() => Promise.all([api.get<any[]>('/member/loans'), api.get<any[]>('/member/applications')]), [], 'm:loans');
  const [picked, setPicked] = useState<LoanTab | null>(null);
  return (
    <>
      <MTop title="My loans" />
      <div className="m-content">
        <Loadable q={q}>{([loans, apps]) => {
          const groups = {
            active: loans.filter((l) => OPEN.includes(l.status) && !isOverdue(l)),
            pending: apps.filter((a) => IN_PROGRESS.includes(a.status)),
            completed: loans.filter((l) => l.status === 'REPAID'),
            overdue: loans.filter(isOverdue),
          };
          // Open on whatever needs the member's attention first.
          const tab: LoanTab = picked ?? (groups.overdue.length ? 'overdue' : groups.active.length ? 'active' : groups.pending.length ? 'pending' : 'active');
          const list = groups[tab];
          const EMPTY: Record<LoanTab, [string, string]> = {
            active: ['No active loan', 'When you take a loan it will appear here.'],
            pending: ['No applications in progress', 'Loan applications waiting for a decision appear here.'],
            completed: ['No completed loans yet', 'Loans you have fully repaid appear here.'],
            overdue: ['Nothing overdue', 'You have no late payments.'],
          };
          return (
            <>
              <Tabs value={tab} onChange={setPicked} items={[
                { value: 'active', label: 'Active', count: groups.active.length }, { value: 'pending', label: 'Pending', count: groups.pending.length },
                { value: 'completed', label: 'Completed', count: groups.completed.length }, { value: 'overdue', label: 'Overdue', count: groups.overdue.length },
              ]} />
              {list.length === 0 ? (
                <Card><EmptyState icon={<Wallet size={22} />} title={EMPTY[tab][0]} text={EMPTY[tab][1]} action={tab === 'active' && !groups.overdue.length && !groups.pending.length ? <Link to="/member/borrow" className="btn btn-primary btn-md">Apply for loan</Link> : undefined} /></Card>
              ) : (
                <div className="stack-sm">{tab === 'pending' ? list.map((a) => <ApplicationCard key={a.id} a={a} />) : list.map((l) => <LoanCard key={l.id} l={l} />)}</div>
              )}
              <Link to="/member/history" className="card behaviour-row">
                <span className="li-icon" aria-hidden><Clock size={18} /></span>
                <span className="li-main"><span className="li-title">Repayment history</span><span className="li-sub">Past payments and statements</span></span>
                <ChevronRight size={18} color="var(--muted)" aria-hidden />
              </Link>
            </>
          );
        }}</Loadable>
      </div>
    </>
  );
}

/** One loan in a list: status in words, then the two numbers that matter for that status. */
function LoanCard({ l }: { l: any }) {
  const open = OPEN.includes(l.status), late = isOverdue(l);
  return (
    <Link to={`/member/loans/${l.id}`} className={`card loan-card ${late ? 'late' : ''}`}>
      <span className="row between nowrap"><b className="lc-name">{l.productName}</b><Badge status={late && l.status !== 'DEFAULTED' ? 'OVERDUE' : l.status} /></span>
      <span className="lc-facts">
        {open ? (
          <>
            <span><span className="g-label">You owe</span><span className="g-value">{kes(l.outstanding)}</span></span>
            <span><span className="g-label">{late ? 'Was due' : 'Due date'}</span><span className={`g-value ${late ? 'text-bad' : ''}`}>{shortDate(l.dueDate)}</span><span className="g-note">{late ? `${plural(l.daysOverdue, 'day')} overdue` : l.daysRemaining === 0 ? 'today' : `in ${plural(l.daysRemaining, 'day')}`}</span></span>
          </>
        ) : (
          <>
            <span><span className="g-label">Borrowed</span><span className="g-value">{kes(l.principal)}</span></span>
            <span><span className="g-label">Repaid</span><span className="g-value">{shortDate(l.repaidAt)}</span><span className="g-note">{l.outcome === 'EARLY' ? 'early' : l.outcome === 'ON_TIME' ? 'on time' : l.outcome === 'LATE' ? 'after the due date' : ''}</span></span>
          </>
        )}
      </span>
      {open && <ProgressBar value={l.progressPct} tone={late ? 'terra' : 'teal'} label={`${l.progressPct}% repaid`} />}
      <span className="row between nowrap small muted"><span>{open ? `${kes(l.amountPaid)} paid of ${kes(l.totalRepayable)}` : `Taken ${monthYear(l.disbursedAt)}`}</span><span className="lc-go">View<ChevronRight size={16} aria-hidden /></span></span>
    </Link>
  );
}

const APP_NOTE: Record<string, string> = {
  APPLIED: 'Submitted. Waiting for a decision.', UNDER_REVIEW: 'Your lender is reviewing this application.', APPROVED: 'Approved. The money is being sent.',
  DISBURSING: 'The money is on its way to your M-PESA.', DISBURSEMENT_FAILED: 'Approved, but the payout is delayed. Your lender will retry.',
};
function ApplicationCard({ a }: { a: any }) {
  return (
    <Link to={`/member/applications/${a.id}`} className="card loan-card">
      <span className="row between nowrap"><b className="lc-name">{a.productName}</b><Badge status={a.status} /></span>
      <span className="lc-facts">
        <span><span className="g-label">Amount</span><span className="g-value">{kes(a.amount)}</span></span>
        <span><span className="g-label">Applied</span><span className="g-value">{shortDate(a.submittedAt)}</span></span>
      </span>
      <span className="row between nowrap small muted"><span>{APP_NOTE[a.status] ?? ''}</span><span className="lc-go">Track<ChevronRight size={16} aria-hidden /></span></span>
    </Link>
  );
}

export function LoanDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const q = useData(() => api.get(`/member/loans/${id}`), [id], `m:loan:${id}`);
  const [terms, setTerms] = useState(false);
  const [extend, setExtend] = useState(false);
  return (
    <>
      <MTop back="/member/loans" title="Loan details" />
      <div className="m-content">
        <Loadable q={q}>{(l) => {
          const open = OPEN.includes(l.status);
          return (
            <>
              {open ? <CurrentLoanHero loan={l} compact /> : (
                <Card>
                  <div className="row between"><h2 style={{ margin: 0 }}>{l.productName}</h2><Badge status={l.status} /></div>
                  <p className="small muted" style={{ margin: '.2rem 0 .6rem' }}>Ref {l.reference} · {fmtDate(l.startDate)} – {fmtDate(l.repaidAt ?? l.dueDate)}</p>
                  <ProgressBar value={100} label="Fully repaid" />
                  {l.outcome && <p className="small" style={{ margin: '.6rem 0 0' }}>{l.outcome === 'EARLY' ? 'Repaid early.' : l.outcome === 'ON_TIME' ? 'Repaid on time.' : 'Repaid after the due date.'} Thank you.</p>}
                </Card>
              )}
              {open && <Button variant="primary" size="lg" block onClick={() => nav(`/member/repay/${l.id}`)}>Pay now</Button>}
              <Card title="Loan summary">
                <KeyValue items={[
                  ['Loan amount', kes(l.principal)], ...(l.interest ? [['Interest', kes(l.interest)] as [string, string]] : []), ...(l.fee ? [['Fees', kes(l.fee)] as [string, string]] : []),
                  ...(l.rolloverFees ? [['Rollover fees', kes(l.rolloverFees)] as [string, string]] : []), ...(l.lateFees ? [['Late fees', kes(l.lateFees)] as [string, string]] : []),
                  ...(l.rebate ? [['Early repayment saving', `− ${kes(l.rebate)}`] as [string, string]] : []),
                  ['Total repayment', kes(l.totalRepayable)], ['Amount paid', kes(l.amountPaid)], ['Outstanding balance', kes(l.outstanding)],
                  ['Due date', fmtDate(l.dueDate)], ...(open ? [[l.daysOverdue ? 'Overdue by' : 'Days remaining', l.daysOverdue ? plural(l.daysOverdue, 'day') : String(l.daysRemaining)] as [string, string]] : []),
                ]} />
              </Card>
              {open && (
                <Card title="What you owe now">
                  <KeyValue items={[['Principal', kes(l.amountDue.principal)], ['Interest', kes(l.amountDue.interest)], ['Fees and late fees', kes(l.amountDue.fees)], ['Total to pay', kes(l.amountDue.total)]]} />
                  <p className="fine" style={{ margin: '.5rem 0 0' }}>{l.lateFeeTerms ? `Late fee: ${l.lateFeeTerms}.` : 'No late fee on this loan.'}{l.rolloverTerms ? ` Rollovers used: ${l.rolloverTerms.used} of ${l.rolloverTerms.max}.` : ''}</p>
                </Card>
              )}
              <Card title="Payment schedule">
                {l.schedule.map((s: any) => (
                  <div key={s.installment} className="list-item"><span className="li-main"><span className="li-title">Single repayment · due {fmtDate(s.dueDate)}</span><span className="li-sub">{kes(s.paid)} of {kes(s.amount)} paid</span></span><Badge status={s.status} /></div>
                ))}
              </Card>
              <Card title="Payments">
                {l.repayments.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No payments yet.</p> : <div className="list">{l.repayments.map((r: any) => <PaymentRow key={r.id} r={r} />)}</div>}
                {l.attempts.filter((t: any) => t.status === 'FAILED').slice(0, 2).map((t: any) => <p key={t.id} className="small text-bad" style={{ margin: '.4rem 0 0' }}><XCircle size={14} style={{ verticalAlign: -2 }} aria-hidden /> {shortDate(t.at)}: payment of {kes(t.amount)} failed. Your balance did not change.</p>)}
              </Card>
              <div className="stack-sm">
                {open && l.rollover?.mode === 'PAY_TO_EXTEND' && (
                  <div className="warn-box">Can’t pay in full? Your loan allows a rollover: pay <b>{kes(l.rollover.amountToPay)}</b> now and your due date moves to <b>{fmtDate(l.rollover.newDueDate)}</b> ({plural(l.rollover.remainingRollovers, 'rollover')} left).<div style={{ marginTop: '.5rem' }}><Button variant="outline" size="sm" onClick={() => setExtend(true)}>Roll over this loan</Button></div></div>
                )}
                <StatementButton url={`/member/loans/${l.id}/statement.pdf`} name={`loan-statement-${l.reference}.pdf`} label="Download statement (PDF)" />
                <Button variant="outline" block onClick={() => setTerms(true)}>View terms</Button>
              </div>
              <Modal open={terms} onClose={() => setTerms(false)} title="Loan terms">
                <p className="small">You borrowed <b>{kes(l.principal)}</b> under <b>{l.product.name}</b> for {l.periodDays} days and agreed to repay <b>{kes(l.totalRepayable)}</b> by {fmtDate(l.originalDueDate)}.</p>
                <KeyValue items={[
                  ['Interest', `${l.product.interestRateMonthly}% per month`], ['Fee', l.product.feeType === 'NONE' ? 'None' : l.product.feeType === 'PERCENTAGE' ? `${l.product.feeValue}%` : kes(l.product.feeValue)],
                  ['Partial payments', l.product.allowPartial ? 'Allowed' : 'Not allowed'], ['Early repayment saving', l.product.earlyRepaymentEnabled ? `${l.product.earlyRepaymentRebatePct}% of unused interest` : 'Not offered'],
                  ['Late fee', l.lateFeeTerms ?? 'None'],
                  ['Rollover', l.product.rolloverEnabled ? `Up to ${l.product.rolloverMax}×, fee ${l.product.rolloverFeePct}%, ${l.product.rolloverPeriodDays} days each${l.product.rolloverMode === 'AUTOMATIC' ? ' (automatic)' : ''}` : 'Not allowed'],
                ]} />
              </Modal>
              {l.rollover && <ExtendModal open={extend} onClose={() => setExtend(false)} loan={l} onDone={() => { setExtend(false); toast('good', 'Your loan has been extended.'); q.reload(true); }} />}
            </>
          );
        }}</Loadable>
      </div>
    </>
  );
}

/** Downloads a PDF statement and tells the member where it went. */
export function StatementButton({ url, name, label }: { url: string; name: string; label: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const saved = await downloadFile(url, name); toast('good', `Saved ${saved} to your downloads.`); }
    catch (e: any) { toast('bad', e.message); } finally { setBusy(false); }
  };
  return <Button variant="outline" block icon={<Download size={16} aria-hidden />} loading={busy} onClick={go}>{label}</Button>;
}

const PaymentRow = ({ r, to }: { r: any; to?: string }) => {
  const body = (
    <>
      <span className="li-icon good" aria-hidden><CheckCircle2 size={18} /></span>
      <span className="li-main"><span className="li-title">{kes(r.amount)} · {PAYMENT_TYPE[r.type] ?? r.type}</span><span className="li-sub">Successful · {fmtDate(r.paidAt, { day: 'numeric', month: 'short', year: 'numeric' })} · {CHANNEL[r.channel] ?? r.channel}{r.productName ? ` · ${r.productName}` : ''}{r.rebate ? ` · saved ${kes(r.rebate)}` : ''}{r.paidFrom ? ` · paid from ${r.paidFrom}` : ''}</span></span>
      <span className="li-end"><span className="tiny muted">Balance</span><br /><b>{kes(r.balanceAfter)}</b></span>
    </>
  );
  return to ? <Link to={to} className="list-item">{body}</Link> : <div className="list-item">{body}</div>;
};

/** Accepts 07XX/01XX, 2547XX or +2547XX numbers, like the server. */
const validMpesa = (p: string) => /^(?:0|254)?[17]\d{8}$/.test(p.replace(/\D/g, ''));

export type Payer = { mode: 'own' | 'other'; phone: string };
/** Choose which M-PESA number receives the payment prompt. */
export function PayFrom({ value, onChange, ownPhone }: { value: Payer; onChange: (v: Payer) => void; ownPhone?: string }) {
  const bad = value.mode === 'other' && value.phone.trim() !== '' && !validMpesa(value.phone);
  return (
    <fieldset className="stack-sm plain-fieldset">
      <legend className="small" style={{ fontFamily: 'var(--display)', fontWeight: 700, color: 'var(--navy)' }}>Pay from</legend>
      <label className="check"><input type="radio" name="payfrom" checked={value.mode === 'own'} onChange={() => onChange({ ...value, mode: 'own' })} /> <span>My M-PESA number{ownPhone ? <> · <b>{ownPhone}</b></> : null}</span></label>
      <label className="check"><input type="radio" name="payfrom" checked={value.mode === 'other'} onChange={() => onChange({ ...value, mode: 'other' })} /> <span>Another M-PESA number<br /><span className="small muted">The payment request goes to that phone, and its owner confirms with their M-PESA PIN.</span></span></label>
      {value.mode === 'other' && (
        <div className="field" style={{ margin: 0 }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="off" placeholder="07XX XXX XXX" aria-label="M-PESA number to pay from" aria-invalid={bad} value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
          {bad && <small className="field-msg err" role="alert">Enter a valid M-PESA number, e.g. 0712 345 678.</small>}
        </div>
      )}
    </fieldset>
  );
}
export const payerOk = (p: Payer) => p.mode === 'own' || validMpesa(p.phone);
export const payerBody = (p: Payer) => (p.mode === 'other' ? { phone: p.phone.trim() } : {});

function ExtendModal({ open, onClose, loan, onDone }: { open: boolean; onClose: () => void; loan: any; onDone: () => void }) {
  const r = loan.rollover;
  const me = useData(() => api.get('/member/profile'), [], 'm:profile');
  const ownPhone: string | undefined = me.data?.phone;
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const [payer, setPayer] = useState<Payer>({ mode: 'own', phone: '' });
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const tx = await api.post(`/member/loans/${loan.id}/rollover`, payerBody(payer));
      const final = await pollPayment(tx.id);
      if (final.status === 'SUCCESS') { clearDataCache(); onDone(); }
      else if (final.status === 'PENDING') setErr('We have not received a confirmation from M-PESA yet. If you approved the payment, your loan will update shortly. Please do not pay again.');
      else setErr(final.message ?? 'Payment could not be completed. Your loan has not changed.');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Roll over your loan" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!payerOk(payer)} onClick={go}>Pay {kes(r.amountToPay)}</Button></>}>
      {err && <Alert tone="bad">{err}</Alert>}
      <p className="small">A rollover moves your due date. It costs money, so only use it if you cannot repay in full on time.</p>
      <KeyValue items={[['Pay now (charges due + rollover fee)', kes(r.amountToPay)], ['Rollover fee', kes(r.rolloverFee)], ['New due date', fmtDate(r.newDueDate)], ['Balance after the rollover', kes(r.newBalance)], ['Rollovers left after this', String(r.remainingRollovers - 1)]]} />
      <div style={{ marginTop: '.8rem' }}><PayFrom value={payer} onChange={setPayer} ownPhone={ownPhone} /></div>
    </Modal>
  );
}

/**
 * Wait for M-PESA to confirm. If nothing arrives in time, or the network drops while waiting, the
 * payment is reported as still PENDING — never as failed, because the money may have moved.
 */
async function pollPayment(id: string, seconds = 30): Promise<any> {
  let last: any = { id, status: 'PENDING' };
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { last = await api.get(`/member/payments/${id}`); } catch { continue; }
    if (last.status !== 'PENDING') return last;
  }
  return { ...last, id, status: 'PENDING' };
}

/** Repayments tab: what is owed and when, the way to pay, and what has been paid. */
export function RepayChooser() {
  const q = useData(() => Promise.all([api.get<any[]>('/member/loans'), api.get<any[]>('/member/repayments')]), [], 'm:repay');
  const nav = useNavigate();
  return (
    <>
      <MTop title="Repayments" />
      <div className="m-content">
        <Loadable q={q}>{([loans, reps]) => {
          const open = loans.filter((l) => OPEN.includes(l.status));
          return (
            <div className="m-cols">
              <div className="m-col">
                {open.length === 0 ? <Card><EmptyState icon={<CheckCircle2 size={22} />} title="Nothing to repay" text="You don’t have an active loan." /></Card>
                  : open.map((l) => {
                    const late = isOverdue(l);
                    return (
                      <Card key={l.id} className={late ? 'warn' : ''}>
                        <div className="row between nowrap" style={{ marginBottom: '.5rem' }}><b className="lc-name">{l.productName}</b><Badge status={late && l.status !== 'DEFAULTED' ? 'OVERDUE' : l.status} /></div>
                        <dl className="kv">
                          <div className="total"><dt>Outstanding balance</dt><dd>{kes(l.outstanding)}</dd></div>
                          <div><dt>Next amount due</dt><dd>{kes(l.outstanding)}</dd></div>
                          <div><dt>Due date</dt><dd className={late ? 'text-bad' : ''}>{fmtDate(l.dueDate)}</dd></div>
                          <div><dt>Payment status</dt><dd>{late ? `${plural(l.daysOverdue, 'day')} overdue` : l.daysRemaining === 0 ? 'Due today' : l.amountPaid > 0 ? `Part paid · ${plural(l.daysRemaining, 'day')} left` : `Not yet due · ${plural(l.daysRemaining, 'day')} left`}</dd></div>
                        </dl>
                        <div style={{ marginTop: '.8rem' }}><Button variant="primary" size="lg" block onClick={() => nav(`/member/repay/${l.id}`)}>Pay now</Button></div>
                      </Card>
                    );
                  })}
              </div>
              <div className="m-col">
                <Card title="Recent payments" action={reps.length > 4 ? <Link to="/member/history" className="small">See all</Link> : undefined}>
                  {reps.length === 0 ? <EmptyState title="No payments yet" text="Payments you make will appear here." />
                    : <div className="list">{reps.slice(0, 4).map((r) => <PaymentRow key={r.id} r={r} to={`/member/loans/${r.loanId}`} />)}</div>}
                </Card>
                {loans.length > 0 && <StatementButton url="/member/statement.pdf" name="loan-statement.pdf" label="Download my loan statement (PDF)" />}
              </div>
            </div>
          );
        }}</Loadable>
      </div>
    </>
  );
}

type Phase = 'form' | 'waiting' | 'done' | 'pending' | 'failed';

export function RepayPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const q = useData(() => api.get(`/member/loans/${id}`), [id]);
  const [amount, setAmount] = useState(0);
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [payer, setPayer] = useState<Payer>({ mode: 'own', phone: '' });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const me = useData(() => api.get('/member/profile'), [], 'm:profile');
  const ownPhone: string | undefined = me.data?.phone;
  const l = q.data;
  const payoff = l ? (l.earlyRepayment?.payoffAmount ?? l.outstanding) : 0;
  // Pre-fill the full payoff whenever the form opens empty (first load, and after a partial payment).
  useEffect(() => { if (l && phase === 'form' && !amount) setAmount(payoff); }, [l, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = (final: any) => {
    setResult(final);
    setPhase(final.status === 'SUCCESS' ? 'done' : final.status === 'FAILED' ? 'failed' : 'pending');
    if (final.status === 'SUCCESS') { clearDataCache(); q.reload(true); } // balances changed: drop saved screens
  };
  const pay = async () => {
    if (busy) return;
    setConfirming(false);
    setBusy(true); setError(null);
    try {
      const tx = await api.post(`/member/loans/${id}/repay`, { amount, ...payerBody(payer) });
      setSentTo(tx.phone ?? null); setResult(tx);
      if (tx.status === 'FAILED') { setPhase('failed'); return; }
      setPhase('waiting');
      settle(await pollPayment(tx.id));
    } catch (e: any) { setError(e.message); setPhase('form'); } finally { setBusy(false); }
  };
  const checkAgain = async () => { setBusy(true); try { settle(await pollPayment(result.id, 8)); } finally { setBusy(false); } };

  if (phase === 'waiting') return (
    <><MTop title="Confirm on your phone" /><div className="m-content m-narrow"><Card><div className="center" style={{ padding: '1.5rem .5rem' }} role="status">
      <Smartphone size={40} color="var(--teal)" aria-hidden /><h2 style={{ marginTop: '.6rem' }}>Check your phone</h2>
      <p className="small muted">We sent an M-PESA request for <b>{kes(amount)}</b> to <b>{sentTo ?? 'your phone'}</b>. {payer.mode === 'other' ? 'The owner of that phone enters their M-PESA PIN to confirm.' : 'Enter your M-PESA PIN to confirm.'}</p>
      <div className="spinner-row"><Loader2 className="spin" size={18} aria-hidden />Waiting for M-PESA…</div>
      <p className="fine" style={{ marginBottom: 0 }}>Please keep this screen open. Do not pay twice.</p></div></Card></div></>
  );
  if (phase === 'pending') return (
    <><MTop title="Payment pending" /><div className="m-content m-narrow">
      <Card><div className="center" style={{ padding: '1rem .5rem' }} role="status">
        <Clock size={48} color="var(--warn)" aria-hidden />
        <h2 style={{ marginTop: '.6rem', fontSize: '1.4rem' }}>Payment pending</h2>
        <p className="small muted" style={{ margin: 0 }}>We have not received a confirmation from M-PESA for <b>{kes(amount)}</b> yet. This can take a few minutes on a slow network.</p>
      </div></Card>
      <Alert tone="warn" title="Please do not pay again yet">If you entered your M-PESA PIN, your balance will update as soon as M-PESA confirms and you will get an SMS. If you did not get a prompt, wait a moment and check again.</Alert>
      <Button variant="primary" size="lg" block loading={busy} onClick={checkAgain}>Check again</Button>
      <Button variant="outline" block onClick={() => nav(`/member/loans/${id}`)}>View my loan</Button>
    </div></>
  );
  if (phase === 'done' || phase === 'failed') {
    const ok = phase === 'done';
    const after = result?.loan?.outstanding ?? 0;
    return (
      <><MTop title={ok ? 'Payment successful' : 'Payment failed'} /><div className="m-content m-narrow">
        <Card><div className="center" style={{ padding: '1rem .5rem' }} role={ok ? 'status' : 'alert'}>
          {ok ? <CheckCircle2 size={48} color="var(--good)" aria-hidden /> : <XCircle size={48} color="var(--terracotta)" aria-hidden />}
          <h2 style={{ marginTop: '.6rem', fontSize: '1.4rem' }}>{ok ? 'Payment successful' : 'Payment failed'}</h2>
          <p className="small muted" style={{ margin: 0 }}>{ok ? `We received ${kes(amount)}. Thank you.` : result?.message ?? 'Payment could not be completed. Your loan balance has not changed.'}</p>
        </div>
          {ok && <KeyValue items={[
            ['Amount paid', kes(amount)], ['Remaining balance', kes(after)], ['M-PESA receipt', result.receipt ?? '—'],
            ...(payer.mode === 'other' && sentTo ? [['Paid from', sentTo] as [string, string]] : []),
            ['Loan status', after === 0 ? 'Fully repaid' : q.data ? (q.data.daysOverdue ? 'Overdue' : 'On track') : '—'],
            ...(after > 0 && q.data ? [['Due date', fmtDate(q.data.dueDate)] as [string, string]] : []),
          ]} />}
          {!ok && result?.reason && <p className="small" style={{ margin: '.8rem 0 0' }}><AlertTriangle size={14} style={{ verticalAlign: -2 }} aria-hidden /> {result.reason}</p>}
        </Card>
        {ok && after === 0 && <Alert tone="good" title="Loan fully repaid">Well done. Your loan behaviour has been updated.</Alert>}
        {ok && after === 0 ? <Button variant="primary" size="lg" block onClick={() => nav('/member/behaviour')}>See my loan behaviour</Button>
          : ok ? <Button variant="primary" size="lg" block onClick={async () => { await q.reload(true); setAmount(0); setPhase('form'); }}>Pay the remaining balance</Button>
          : <Button variant="primary" size="lg" block onClick={() => setPhase('form')}>Try again</Button>}
        <Button variant="outline" block onClick={() => nav('/member')}>Back to home</Button>
      </div></>
    );
  }
  return (
    <>
      <MTop back={`/member/loans/${id}`} title="Make a payment" />
      <div className="m-content m-narrow">
        <Loadable q={q}>{(l) => {
          if (!OPEN.includes(l.status)) return <Card><EmptyState icon={<CheckCircle2 size={22} />} title="This loan is fully repaid" text="There is nothing more to pay." action={<Link to={`/member/loans/${l.id}`} className="btn btn-outline btn-md">View loan</Link>} /></Card>;
          const partialOk = l.product.allowPartial;
          const late = l.daysOverdue > 0;
          const err = amount < 1 ? 'Enter an amount.' : amount > l.outstanding ? `The most you can pay is ${kes(l.outstanding)}.` : !partialOk && amount < payoff ? `This loan must be repaid in full (${kes(payoff)}).` : null;
          const chips = partialOk ? [...new Set([0.25, 0.5].map((f) => Math.max(1, Math.round((l.outstanding * f) / 100) * 100)))].filter((v) => v < payoff) : [];
          return (
            <>
              {error && <Alert tone="bad">{error}</Alert>}
              <Card>
                <dl className="kv">
                  <div className="total"><dt>Outstanding balance</dt><dd>{kes(l.outstanding)}</dd></div>
                  <div><dt>Due date</dt><dd className={late ? 'text-bad' : ''}>{fmtDate(l.dueDate)}</dd></div>
                  <div><dt>Payment status</dt><dd>{late ? `${plural(l.daysOverdue, 'day')} overdue` : l.daysRemaining === 0 ? 'Due today' : `${plural(l.daysRemaining, 'day')} left`}</dd></div>
                  {l.earlyRepayment && <div><dt>Pay in full today</dt><dd>{kes(payoff)} (save {kes(l.earlyRepayment.saving)})</dd></div>}
                </dl>
                <details className="more">
                  <summary>What makes up this amount</summary>
                  <KeyValue items={[['Principal', kes(l.amountDue.principal)], ['Interest', kes(l.amountDue.interest)], ['Fees and late fees', kes(l.amountDue.fees)]]} />
                </details>
                {late && l.lateFees > 0 && <p className="small text-bad" style={{ margin: '.5rem 0 0' }}>Includes {kes(l.lateFees)} in late fees.</p>}
              </Card>
              <Card>
                <label htmlFor="amt" className="small" style={{ fontFamily: 'var(--display)', fontWeight: 700, color: 'var(--navy)' }}>Amount to pay</label>
                <div className="amount-box solo"><span aria-hidden>KES</span><input id="amt" className="input amount-input" inputMode="numeric" pattern="[0-9,]*" autoComplete="off" aria-invalid={!!err && amount > 0} aria-describedby="amt-help" value={amount ? amount.toLocaleString('en-KE') : ''} onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')) || 0)} /></div>
                <p id="amt-help" className={`small amt-help ${err && amount > 0 ? 'text-bad' : 'muted'}`} role={err && amount > 0 ? 'alert' : undefined}>
                  {err && amount > 0 ? err : partialOk ? `Minimum KES 1 · Maximum ${kes(l.outstanding)}` : `This loan is repaid in one payment of ${kes(payoff)}.`}
                </p>
                <Button variant="teal" block onClick={() => setAmount(payoff)}>Pay full amount · {kes(payoff)}</Button>
                {chips.length > 0 && (
                  <div className="chip-row" role="group" aria-label="Pay part of the amount">
                    {chips.map((v) => <button key={v} type="button" className={`pick ${amount === v ? 'on' : ''}`} aria-pressed={amount === v} onClick={() => setAmount(v)}>{kes(v)}</button>)}
                  </div>
                )}
              </Card>
              <Card><PayFrom value={payer} onChange={setPayer} ownPhone={ownPhone} /></Card>
              <Button variant="primary" size="lg" block loading={busy} disabled={!!err || !payerOk(payer)} onClick={() => setConfirming(true)}>Pay {amount ? kes(amount) : ''}</Button>
              <p className="fine center">You will check the amount and number before anything is sent.</p>
              {(() => {
                const number = payer.mode === 'own' ? (ownPhone ?? 'your M-PESA number') : payer.phone.trim();
                return (
                  <Modal open={confirming} onClose={() => setConfirming(false)} title="Confirm your payment"
                    footer={<><Button variant="outline" onClick={() => setConfirming(false)}>Change</Button><Button variant="primary" onClick={pay}>Confirm and pay</Button></>}>
                    <dl className="kv">
                      <div className="total"><dt>Amount</dt><dd>{kes(amount)}</dd></div>
                      <div><dt>M-PESA number</dt><dd>{number}</dd></div>
                      <div><dt>{amount >= payoff ? 'After this payment' : 'You will still owe'}</dt><dd>{amount >= payoff ? 'Loan fully repaid' : kes(l.outstanding - amount)}</dd></div>
                    </dl>
                    <p className="small" style={{ margin: '.9rem 0 0' }}>{payer.mode === 'own' ? <>You will receive an M-PESA prompt on <b>{number}</b>. Enter your M-PESA PIN to complete the payment.</> : <>An M-PESA prompt will be sent to <b>{number}</b>. The owner of that phone enters their M-PESA PIN to complete the payment.</>}</p>
                    <p className="fine" style={{ margin: '.5rem 0 0' }}>Nothing is taken until the M-PESA PIN is entered.</p>
                  </Modal>
                );
              })()}
              <p className="fine center">Demo: an amount of exactly KES 999 simulates a failed payment.</p>
            </>
          );
        }}</Loadable>
      </div>
    </>
  );
}

export function HistoryPage() {
  const q = useData(() => Promise.all([api.get<any[]>('/member/repayments'), api.get<any[]>('/member/loans')]), [], 'm:history');
  const [tab, setTab] = useState<'payments' | 'loans'>('payments');
  return (
    <>
      <MTop back="/member/repay" title="Repayment history" />
      <div className="m-content">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'payments', label: 'Payments' }, { value: 'loans', label: 'Loans' }]} />
        <Loadable q={q}>{([reps, loans]) => tab === 'payments' ? (
          reps.length === 0 ? <Card><EmptyState title="No payments yet" text="Payments you make will appear here." /></Card>
            : <Card><div className="list">{reps.map((r) => <PaymentRow key={r.id} r={r} to={`/member/loans/${r.loanId}`} />)}</div></Card>
        ) : (loans.length === 0 ? <Card><EmptyState title="No loans yet" /></Card> : <div className="stack-sm">{loans.map((l) => <LoanCard key={l.id} l={l} />)}</div>)}</Loadable>
        <StatementButton url="/member/statement.pdf" name="loan-statement.pdf" label="Download my loan statement (PDF)" />
      </div>
    </>
  );
}
