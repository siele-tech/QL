import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Download, Loader2, Smartphone, Wallet, XCircle } from 'lucide-react';
import { api, downloadFile } from '../api';
import { Alert, Badge, Button, Card, EmptyState, KeyValue, Loadable, Modal, ProgressBar, Tabs, clearDataCache, useData, useToast } from '../components/ui';
import { CHANNEL, PAYMENT_TYPE, fmtDate, kes, monthYear, shortDate } from '../format';
import { days, rich, t } from '../i18n';
import { MTop } from './MemberApp';
import { CurrentLoanHero } from './Home';

const OPEN = ['ACTIVE', 'DUE', 'OVERDUE', 'ROLLED_OVER', 'DEFAULTED'];
const IN_PROGRESS = ['APPLIED', 'UNDER_REVIEW', 'APPROVED', 'DISBURSING', 'DISBURSEMENT_FAILED'];
const isOverdue = (l: any) => OPEN.includes(l.status) && (l.daysOverdue > 0 || ['OVERDUE', 'DEFAULTED'].includes(l.status));
/** How late, in words: "Late · 9 days ago". */
const lateText = (l: any) => (l.daysOverdue > 0 ? t('Late · {a} ago', { a: days(l.daysOverdue) }) : t('Late'));
type LoanTab = 'active' | 'pending' | 'completed' | 'overdue';

export function LoansPage() {
  const q = useData(() => Promise.all([api.get<any[]>('/member/loans'), api.get<any[]>('/member/applications')]), [], 'm:loans');
  const [picked, setPicked] = useState<LoanTab | null>(null);
  return (
    <>
      <MTop title={t('My loans')} />
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
            active: [t('You have no loan now'), t('When you take a loan it will appear here.')],
            pending: [t('No applications in progress'), t('Loan applications waiting for a decision appear here.')],
            completed: [t('No finished loans yet'), t('Loans you have paid back appear here.')],
            overdue: [t('Nothing is late'), t('You have no late payments.')],
          };
          return (
            <>
              <Tabs value={tab} onChange={setPicked} items={[
                { value: 'active', label: t('Now'), count: groups.active.length }, { value: 'pending', label: t('Waiting'), count: groups.pending.length },
                { value: 'completed', label: t('Paid back'), count: groups.completed.length }, { value: 'overdue', label: t('Late'), count: groups.overdue.length },
              ]} />
              {list.length === 0 ? (
                <Card><EmptyState icon={<Wallet size={22} />} title={EMPTY[tab][0]} text={EMPTY[tab][1]} action={tab === 'active' && !groups.overdue.length && !groups.pending.length ? <Link to="/member/borrow" className="btn btn-primary btn-md">{t('Apply for loan')}</Link> : undefined} /></Card>
              ) : (
                <div className="stack-sm">{tab === 'pending' ? list.map((a) => <ApplicationCard key={a.id} a={a} />) : list.map((l) => <LoanCard key={l.id} l={l} />)}</div>
              )}
              <Link to="/member/history" className="card behaviour-row">
                <span className="li-icon" aria-hidden><Clock size={18} /></span>
                <span className="li-main"><span className="li-title">{t('What I have paid')}</span><span className="li-sub">{t('Past payments and statements')}</span></span>
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
            <span><span className="g-label">{t('You owe')}</span><span className="g-value">{kes(l.outstanding)}</span></span>
            <span><span className="g-label">{late ? t('Was due') : t('Pay back by')}</span><span className={`g-value ${late ? 'text-bad' : ''}`}>{shortDate(l.dueDate)}</span><span className="g-note">{late ? (l.daysOverdue > 0 ? t('{a} ago', { a: days(l.daysOverdue) }) : t('late')) : l.daysRemaining === 0 ? t('today') : t('in {a}', { a: days(l.daysRemaining) })}</span></span>
          </>
        ) : (
          <>
            <span><span className="g-label">{t('Borrowed')}</span><span className="g-value">{kes(l.principal)}</span></span>
            <span><span className="g-label">{t('Paid back')}</span><span className="g-value">{shortDate(l.repaidAt)}</span><span className="g-note">{l.outcome === 'EARLY' ? t('early') : l.outcome === 'ON_TIME' ? t('on time') : l.outcome === 'LATE' ? t('after the due date') : ''}</span></span>
          </>
        )}
      </span>
      {open && <ProgressBar value={l.progressPct} tone={late ? 'terra' : 'teal'} label={t('{a}% paid back', { a: l.progressPct })} />}
      <span className="row between nowrap small muted"><span>{open ? t('{a} paid of {b}', { a: kes(l.amountPaid), b: kes(l.totalRepayable) }) : t('Taken {a}', { a: monthYear(l.disbursedAt) })}</span><span className="lc-go">{t('View')}<ChevronRight size={16} aria-hidden /></span></span>
    </Link>
  );
}

const APP_NOTE: Record<string, string> = {
  APPLIED: 'Sent. Waiting for an answer.', UNDER_REVIEW: 'Your lender is checking this application.', APPROVED: 'Approved. The money is being sent.',
  DISBURSING: 'The money is on its way to your M-PESA.', DISBURSEMENT_FAILED: 'Approved, but the money is delayed. Your lender will try again.',
};
function ApplicationCard({ a }: { a: any }) {
  return (
    <Link to={`/member/applications/${a.id}`} className="card loan-card">
      <span className="row between nowrap"><b className="lc-name">{a.productName}</b><Badge status={a.status} /></span>
      <span className="lc-facts">
        <span><span className="g-label">{t('Amount')}</span><span className="g-value">{kes(a.amount)}</span></span>
        <span><span className="g-label">{t('Applied')}</span><span className="g-value">{shortDate(a.submittedAt)}</span></span>
      </span>
      <span className="row between nowrap small muted"><span>{t(APP_NOTE[a.status] ?? '')}</span><span className="lc-go">{t('Track')}<ChevronRight size={16} aria-hidden /></span></span>
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
      <MTop back="/member/loans" title={t('Loan details')} />
      <div className="m-content m-mid">
        <Loadable q={q}>{(l) => {
          const open = OPEN.includes(l.status);
          return (
            <>
              {open ? <CurrentLoanHero loan={l} compact /> : (
                <Card>
                  <div className="row between"><h2 style={{ margin: 0 }}>{l.productName}</h2><Badge status={l.status} /></div>
                  <p className="small muted" style={{ margin: '.2rem 0 .6rem' }}>Ref {l.reference} · {fmtDate(l.startDate)} – {fmtDate(l.repaidAt ?? l.dueDate)}</p>
                  <ProgressBar value={100} label={t('All paid back')} />
                  {l.outcome && <p className="small" style={{ margin: '.6rem 0 0' }}>{l.outcome === 'EARLY' ? t('Paid back early.') : l.outcome === 'ON_TIME' ? t('Paid back on time.') : t('Paid back late.')} {t('Thank you.')}</p>}
                </Card>
              )}
              {open && <Button variant="primary" size="lg" block onClick={() => nav(`/member/repay/${l.id}`)}>{t('Pay now')}</Button>}
              <Card title={t('About this loan')}>
                <KeyValue items={[
                  [t('You borrowed'), kes(l.principal)], ...(l.interest ? [[t('Interest'), kes(l.interest)] as [string, string]] : []), ...(l.fee ? [[t('Fees'), kes(l.fee)] as [string, string]] : []),
                  ...(l.rolloverFees ? [[t('Fees for more time'), kes(l.rolloverFees)] as [string, string]] : []), ...(l.lateFees ? [[t('Added for paying late'), kes(l.lateFees)] as [string, string]] : []),
                  ...(l.rebate ? [[t('Saved by paying early'), `− ${kes(l.rebate)}`] as [string, string]] : []),
                  [t('You pay back'), kes(l.totalRepayable)], [t('You have paid'), kes(l.amountPaid)], [t('You still owe'), kes(l.outstanding)],
                  [t('Pay it back before'), fmtDate(l.dueDate)], ...(open ? [[l.daysOverdue ? t('Late by') : t('Days left'), l.daysOverdue ? days(l.daysOverdue) : String(l.daysRemaining)] as [string, string]] : []),
                ]} />
              </Card>
              {open && (
                <Card title={t('What you owe now')}>
                  <KeyValue items={[[t('Money you borrowed'), kes(l.amountDue.principal)], [t('Interest'), kes(l.amountDue.interest)], [t('Fees, and extra for paying late'), kes(l.amountDue.fees)], [t('All together'), kes(l.amountDue.total)]]} />
                  <p className="fine" style={{ margin: '.5rem 0 0' }}>{l.lateFeeTerms ? t('If you pay late: {a}.', { a: l.lateFeeTerms }) : t('Paying late does not cost more on this loan.')}{l.rolloverTerms ? ' ' + t('More time used: {a} of {b} times.', { a: l.rolloverTerms.used, b: l.rolloverTerms.max }) : ''}</p>
                </Card>
              )}
              <Card title={t('When to pay')}>
                {l.schedule.map((s: any) => (
                  <div key={s.installment} className="list-item"><span className="li-main"><span className="li-title">{t('One payment · before {a}', { a: fmtDate(s.dueDate) })}</span><span className="li-sub">{t('{a} of {b} paid', { a: kes(s.paid), b: kes(s.amount) })}</span></span><Badge status={s.status} /></div>
                ))}
              </Card>
              <Card title={t('Payments')}>
                {l.repayments.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('No payments yet.')}</p> : <div className="list">{l.repayments.map((r: any) => <PaymentRow key={r.id} r={r} />)}</div>}
                {l.attempts.filter((x: any) => x.status === 'FAILED').slice(0, 2).map((x: any) => <p key={x.id} className="small text-bad" style={{ margin: '.4rem 0 0' }}><XCircle size={14} style={{ verticalAlign: -2 }} aria-hidden /> {t('{a}: payment of {b} did not go through. What you owe did not change.', { a: shortDate(x.at), b: kes(x.amount) })}</p>)}
              </Card>
              <div className="stack-sm">
                {open && l.rollover?.mode === 'PAY_TO_EXTEND' && (
                  <div className="warn-box">{rich(t('Can’t pay it all? You can get more time: pay <b>{a}</b> now and you have until <b>{b}</b> to pay the rest. Times you can do this: {c}.', { a: kes(l.rollover.amountToPay), b: fmtDate(l.rollover.newDueDate), c: l.rollover.remainingRollovers }))}<div style={{ marginTop: '.5rem' }}><Button variant="outline" size="sm" onClick={() => setExtend(true)}>{t('Get more time to pay')}</Button></div></div>
                )}
                <StatementButton url={`/member/loans/${l.id}/statement.pdf`} name={`loan-statement-${l.reference}.pdf`} label={t('Download statement (PDF)')} />
                <Button variant="outline" block onClick={() => setTerms(true)}>{t('View terms')}</Button>
              </div>
              <Modal open={terms} onClose={() => setTerms(false)} title={t('Loan terms')}>
                <p className="small">{rich(t('You borrowed <b>{a}</b> under <b>{b}</b> for {c} and agreed to pay back <b>{d}</b> by {e}.', { a: kes(l.principal), b: l.product.name, c: days(l.periodDays), d: kes(l.totalRepayable), e: fmtDate(l.originalDueDate) }))}</p>
                <KeyValue items={[
                  [t('Interest'), t('{a}% per month', { a: l.product.interestRateMonthly })], [t('Fee'), l.product.feeType === 'NONE' ? t('None') : l.product.feeType === 'PERCENTAGE' ? `${l.product.feeValue}%` : kes(l.product.feeValue)],
                  [t('Paying in parts'), l.product.allowPartial ? t('Allowed') : t('Not allowed')], [t('Saving if you pay early'), l.product.earlyRepaymentEnabled ? t('{a}% of the interest for unused days', { a: l.product.earlyRepaymentRebatePct }) : t('None')],
                  [t('If you pay late'), l.lateFeeTerms ?? t('No extra cost')],
                  [t('More time to pay'), l.product.rolloverEnabled ? t('Up to {a} times, {b} days each, {c}% fee each time', { a: l.product.rolloverMax, b: l.product.rolloverPeriodDays, c: l.product.rolloverFeePct }) + (l.product.rolloverMode === 'AUTOMATIC' ? ' ' + t('(automatic)') : '') : t('Not allowed')],
                ]} />
              </Modal>
              {l.rollover && <ExtendModal open={extend} onClose={() => setExtend(false)} loan={l} onDone={() => { setExtend(false); toast('good', t('You now have more time to pay.')); q.reload(true); }} />}
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
    try { const saved = await downloadFile(url, name); toast('good', t('Saved {a} to your downloads.', { a: saved })); }
    catch (e: any) { toast('bad', e.message); } finally { setBusy(false); }
  };
  return <Button variant="outline" block icon={<Download size={16} aria-hidden />} loading={busy} onClick={go}>{label}</Button>;
}

const PaymentRow = ({ r, to }: { r: any; to?: string }) => {
  const body = (
    <>
      <span className="li-icon good" aria-hidden><CheckCircle2 size={18} /></span>
      <span className="li-main"><span className="li-title">{kes(r.amount)} · {t(PAYMENT_TYPE[r.type] ?? r.type)}</span><span className="li-sub">{t('Successful')} · {fmtDate(r.paidAt, { day: 'numeric', month: 'short', year: 'numeric' })} · {t(CHANNEL[r.channel] ?? r.channel)}{r.productName ? ` · ${r.productName}` : ''}{r.rebate ? ' · ' + t('saved {a}', { a: kes(r.rebate) }) : ''}{r.paidFrom ? ' · ' + t('paid from {a}', { a: r.paidFrom }) : ''}</span></span>
      <span className="li-end"><span className="tiny muted">{t('Still owed')}</span><br /><b>{kes(r.balanceAfter)}</b></span>
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
      <legend className="small" style={{ fontFamily: 'var(--display)', fontWeight: 700, color: 'var(--navy)' }}>{t('Pay from')}</legend>
      <label className="check"><input type="radio" name="payfrom" checked={value.mode === 'own'} onChange={() => onChange({ ...value, mode: 'own' })} /> <span>{t('My M-PESA number')}{ownPhone ? <> · <b>{ownPhone}</b></> : null}</span></label>
      <label className="check"><input type="radio" name="payfrom" checked={value.mode === 'other'} onChange={() => onChange({ ...value, mode: 'other' })} /> <span>{t('Another M-PESA number')}<br /><span className="small muted">{t('The payment request goes to that phone, and its owner confirms with their M-PESA PIN.')}</span></span></label>
      {value.mode === 'other' && (
        <div className="field" style={{ margin: 0 }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="off" placeholder="07XX XXX XXX" aria-label={t('M-PESA number to pay from')} aria-invalid={bad} value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
          {bad && <small className="field-msg err" role="alert">{t('Enter a valid M-PESA number, e.g. 0712 345 678.')}</small>}
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
      else if (final.status === 'PENDING') setErr(t('We have not received a confirmation from M-PESA yet. If you approved the payment, your loan will update shortly. Please do not pay again.'));
      else setErr(final.message ?? t('The payment did not go through. Your loan has not changed.'));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t('Get more time to pay')} footer={<><Button variant="outline" onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" loading={busy} disabled={!payerOk(payer)} onClick={go}>{t('Pay {a}', { a: kes(r.amountToPay) })}</Button></>}>
      {err && <Alert tone="bad">{err}</Alert>}
      <p className="small">{t('This gives you more days to pay. It costs money, so only use it if you cannot pay everything on time.')}</p>
      <KeyValue items={[[t('You pay now'), kes(r.amountToPay)], [t('Of that, the fee for more time'), kes(r.rolloverFee)], [t('Then pay it back before'), fmtDate(r.newDueDate)], [t('You will still owe'), kes(r.newBalance)], [t('Times you can do this again'), String(r.remainingRollovers - 1)]]} />
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
      <MTop title={t('Pay back')} />
      <div className="m-content">
        <Loadable q={q}>{([loans, reps]) => {
          const open = loans.filter((l) => OPEN.includes(l.status));
          return (
            <div className="m-cols">
              <div className="m-col">
                {open.length === 0 ? <Card><EmptyState icon={<CheckCircle2 size={22} />} title={t('Nothing to pay')} text={t('You have no loan now.')} /></Card>
                  : open.map((l) => {
                    const late = isOverdue(l);
                    return (
                      <Card key={l.id} className={late ? 'warn' : ''}>
                        <div className="row between nowrap" style={{ marginBottom: '.5rem' }}><b className="lc-name">{l.productName}</b><Badge status={late && l.status !== 'DEFAULTED' ? 'OVERDUE' : l.status} /></div>
                        <dl className="kv">
                          <div className="total"><dt>{t('You owe')}</dt><dd>{kes(l.outstanding)}</dd></div>
                          <div><dt>{late ? t('Was due on') : t('Pay it back before')}</dt><dd className={late ? 'text-bad' : ''}>{fmtDate(l.dueDate)}</dd></div>
                          <div><dt>{t('Time')}</dt><dd>{late ? lateText(l) : l.daysRemaining === 0 ? t('Pay today') : l.amountPaid > 0 ? t('Part paid · {a} left', { a: days(l.daysRemaining) }) : t('{a} left', { a: days(l.daysRemaining) })}</dd></div>
                        </dl>
                        <div style={{ marginTop: '.8rem' }}><Button variant="primary" size="lg" block onClick={() => nav(`/member/repay/${l.id}`)}>{t('Pay now')}</Button></div>
                      </Card>
                    );
                  })}
              </div>
              <div className="m-col">
                <Card title={t('Recent payments')} action={reps.length > 4 ? <Link to="/member/history" className="small">{t('See all')}</Link> : undefined}>
                  {reps.length === 0 ? <EmptyState title={t('No payments yet')} text={t('Payments you make will appear here.')} />
                    : <div className="list">{reps.slice(0, 4).map((r) => <PaymentRow key={r.id} r={r} to={`/member/loans/${r.loanId}`} />)}</div>}
                </Card>
                {loans.length > 0 && <StatementButton url="/member/statement.pdf" name="loan-statement.pdf" label={t('Download my loan statement (PDF)')} />}
              </div>
            </div>
          );
        }}</Loadable>
      </div>
    </>
  );
}

type Phase = 'form' | 'waiting' | 'done' | 'pending' | 'failed';
type Note = { tone: 'good' | 'bad'; text: string };

/** A little longer than the server asks for, so the button never opens onto a "wait" error. */
const RESEND_AFTER_MS = 21_000;

/** After a short wait, lets the member ask for the M-PESA request again if it never reached the phone. */
function ResendPrompt({ sentAt, busy, note, onResend }: { sentAt: number; busy: boolean; note: Note | null; onResend: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  const wait = Math.ceil((sentAt + RESEND_AFTER_MS - now) / 1000);
  return (
    <div className="resend">
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <b className="small">{t('Did not get the request on your phone?')}</b>
      <Button variant="outline" block loading={busy} disabled={wait > 0} onClick={onResend}>{wait > 0 ? t('Send it again in {a} seconds', { a: wait }) : t('Send it again')}</Button>
      <p className="fine" style={{ margin: 0 }}>{t('If two requests reach the phone, approve only one.')}</p>
    </div>
  );
}

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
  const [sentAt, setSentAt] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState<Note | null>(null);
  const active = useRef<string | null>(null); // the request being waited on
  const paid = useRef(false);
  const me = useData(() => api.get('/member/profile'), [], 'm:profile');
  const ownPhone: string | undefined = me.data?.phone;
  const l = q.data;
  const payoff = l ? (l.earlyRepayment?.payoffAmount ?? l.outstanding) : 0;
  // Pre-fill the full payoff whenever the form opens empty (first load, and after a partial payment).
  useEffect(() => { if (l && phase === 'form' && !amount) setAmount(payoff); }, [l, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = (final: any) => {
    if (paid.current) return; // once the money is in, a slower answer about another request changes nothing
    if (final.status === 'SUCCESS') paid.current = true;
    setResult(final);
    setPhase(final.status === 'SUCCESS' ? 'done' : final.status === 'FAILED' ? 'failed' : 'pending');
    if (final.status === 'SUCCESS') { clearDataCache(); q.reload(true); } // balances changed: drop saved screens
  };
  // Follow one request to its end. After a resend, the earlier request is only believed if it succeeded.
  const watch = async (txId: string, seconds?: number) => {
    active.current = txId;
    const final = await pollPayment(txId, seconds);
    if (final.status === 'SUCCESS' || active.current === txId) settle(final);
  };
  const pay = async () => {
    if (busy) return;
    setConfirming(false);
    setBusy(true); setError(null); setResendNote(null); paid.current = false;
    try {
      const tx = await api.post(`/member/loans/${id}/repay`, { amount, ...payerBody(payer) });
      setSentTo(tx.phone ?? null); setResult(tx); setSentAt(Date.now());
      if (tx.status === 'FAILED') { setPhase('failed'); return; }
      setPhase('waiting');
      await watch(tx.id);
    } catch (e: any) { setError(e.message); setPhase('form'); } finally { setBusy(false); }
  };
  const checkAgain = async () => { setBusy(true); try { await watch(result.id, 8); } finally { setBusy(false); } };
  /** The prompt never reached the phone: ask for another one for the same amount and number. */
  const resend = async () => {
    setResending(true); setResendNote(null);
    try {
      const tx = await api.post(`/member/payments/${result.id}/resend`);
      active.current = tx.id;
      setResult(tx); setSentAt(Date.now());
      if (tx.status === 'FAILED') { settle(tx); return; }
      setResendNote({ tone: 'good', text: t('We sent the request again. Check your phone.') });
      setPhase('waiting');
      void watch(tx.id);
    } catch (e: any) {
      setResendNote({ tone: 'bad', text: e.message });
      if (e.code === 'PAYMENT_RECEIVED' || e.code === 'PAYMENT_NOT_PENDING') void watch(result.id, 3); // it finished while we were asking
    } finally { setResending(false); }
  };

  if (phase === 'waiting') return (
    <><MTop title={t('Confirm on your phone')} /><div className="m-content m-narrow"><Card><div className="center" style={{ padding: '1.5rem .5rem' }} role="status">
      <Smartphone size={40} color="var(--teal)" aria-hidden /><h2 style={{ marginTop: '.6rem' }}>{t('Check your phone')}</h2>
      <p className="small muted">{rich(t('We sent an M-PESA request for <b>{a}</b> to <b>{b}</b>.', { a: kes(amount), b: sentTo ?? t('your phone') }))} {payer.mode === 'other' ? t('The owner of that phone enters their M-PESA PIN to confirm.') : t('Enter your M-PESA PIN to confirm.')}</p>
      <div className="spinner-row"><Loader2 className="spin" size={18} aria-hidden />{t('Waiting for M-PESA…')}</div>
      <p className="fine" style={{ marginBottom: 0 }}>{t('Please keep this screen open. Do not pay twice.')}</p></div></Card>
      <ResendPrompt sentAt={sentAt} busy={resending} note={resendNote} onResend={resend} /></div></>
  );
  if (phase === 'pending') return (
    <><MTop title={t('Waiting for M-PESA')} /><div className="m-content m-narrow">
      <Card><div className="center" style={{ padding: '1rem .5rem' }} role="status">
        <Clock size={48} color="var(--warn)" aria-hidden />
        <h2 style={{ marginTop: '.6rem', fontSize: '1.4rem' }}>{t('Waiting for M-PESA')}</h2>
        <p className="small muted" style={{ margin: 0 }}>{rich(t('M-PESA has not told us about your <b>{a}</b> yet. This can take a few minutes on a slow network.', { a: kes(amount) }))}</p>
      </div></Card>
      <Alert tone="warn" title={t('Please do not pay again yet')}>{t('If you entered your M-PESA PIN, what you owe will go down as soon as M-PESA confirms, and you will get an SMS. If you did not get a prompt, wait a moment and check again.')}</Alert>
      <Button variant="primary" size="lg" block loading={busy} onClick={checkAgain}>{t('Check again')}</Button>
      <ResendPrompt sentAt={sentAt} busy={resending} note={resendNote} onResend={resend} />
      <Button variant="outline" block onClick={() => nav(`/member/loans/${id}`)}>{t('View my loan')}</Button>
    </div></>
  );
  if (phase === 'done' || phase === 'failed') {
    const ok = phase === 'done';
    const after = result?.loan?.outstanding ?? 0;
    return (
      <><MTop title={ok ? t('Payment received') : t('Payment did not go through')} /><div className="m-content m-narrow">
        <Card><div className="center" style={{ padding: '1rem .5rem' }} role={ok ? 'status' : 'alert'}>
          {ok ? <CheckCircle2 size={48} color="var(--good)" aria-hidden /> : <XCircle size={48} color="var(--terracotta)" aria-hidden />}
          <h2 style={{ marginTop: '.6rem', fontSize: '1.4rem' }}>{ok ? t('Payment received') : t('Payment did not go through')}</h2>
          <p className="small muted" style={{ margin: 0 }}>{ok ? t('We received {a}. Thank you.', { a: kes(amount) }) : result?.message ?? t('The payment did not go through. What you owe has not changed.')}</p>
        </div>
          {ok && <KeyValue items={[
            [t('You paid'), kes(amount)], [t('You still owe'), kes(after)], [t('M-PESA receipt'), result.receipt ?? '—'],
            ...(payer.mode === 'other' && sentTo ? [[t('Paid from'), sentTo] as [string, string]] : []),
            [t('Your loan'), after === 0 ? t('All paid back') : q.data ? (q.data.daysOverdue ? t('Late') : t('On time')) : '—'],
            ...(after > 0 && q.data ? [[q.data.daysOverdue ? t('Was due on') : t('Pay it back before'), fmtDate(q.data.dueDate)] as [string, string]] : []),
          ]} />}
          {!ok && result?.reason && <p className="small" style={{ margin: '.8rem 0 0' }}><AlertTriangle size={14} style={{ verticalAlign: -2 }} aria-hidden /> {result.reason}</p>}
        </Card>
        {ok && after === 0 && <Alert tone="good" title={t('Loan all paid back')}>{t('Well done. Your loan behaviour has been updated.')}</Alert>}
        {ok && after === 0 ? <Button variant="primary" size="lg" block onClick={() => nav('/member/behaviour')}>{t('See my loan behaviour')}</Button>
          : ok ? <Button variant="primary" size="lg" block onClick={async () => { await q.reload(true); setAmount(0); setPhase('form'); }}>{t('Pay the rest')}</Button>
          : <Button variant="primary" size="lg" block onClick={() => setPhase('form')}>{t('Try again')}</Button>}
        <Button variant="outline" block onClick={() => nav('/member')}>{t('Back to home')}</Button>
      </div></>
    );
  }
  return (
    <>
      <MTop back={`/member/loans/${id}`} title={t('Make a payment')} />
      <div className="m-content m-narrow">
        <Loadable q={q}>{(l) => {
          if (!OPEN.includes(l.status)) return <Card><EmptyState icon={<CheckCircle2 size={22} />} title={t('This loan is all paid back')} text={t('There is nothing more to pay.')} action={<Link to={`/member/loans/${l.id}`} className="btn btn-outline btn-md">{t('View loan')}</Link>} /></Card>;
          const partialOk = l.product.allowPartial;
          const late = l.daysOverdue > 0;
          const err = amount < 1 ? t('Enter an amount.') : amount > l.outstanding ? t('The most you can pay is {a}.', { a: kes(l.outstanding) }) : !partialOk && amount < payoff ? t('This loan is paid back in one payment ({a}).', { a: kes(payoff) }) : null;
          const chips = partialOk ? [...new Set([0.25, 0.5].map((f) => Math.max(1, Math.round((l.outstanding * f) / 100) * 100)))].filter((v) => v < payoff) : [];
          return (
            <>
              {error && <Alert tone="bad">{error}</Alert>}
              <Card>
                <dl className="kv">
                  <div className="total"><dt>{t('You owe')}</dt><dd>{kes(l.outstanding)}</dd></div>
                  <div><dt>{late ? t('Was due on') : t('Pay it back before')}</dt><dd className={late ? 'text-bad' : ''}>{fmtDate(l.dueDate)}</dd></div>
                  <div><dt>{t('Time')}</dt><dd>{late ? lateText(l) : l.daysRemaining === 0 ? t('Pay today') : t('{a} left', { a: days(l.daysRemaining) })}</dd></div>
                  {l.earlyRepayment && <div><dt>{t('Pay it all today')}</dt><dd>{t('{a} (you save {b})', { a: kes(payoff), b: kes(l.earlyRepayment.saving) })}</dd></div>}
                </dl>
                <details className="more">
                  <summary>{t('What is in this amount')}</summary>
                  <KeyValue items={[[t('Money you borrowed'), kes(l.amountDue.principal)], [t('Interest'), kes(l.amountDue.interest)], [t('Fees, and extra for paying late'), kes(l.amountDue.fees)]]} />
                </details>
                {late && l.lateFees > 0 && <p className="small text-bad" style={{ margin: '.5rem 0 0' }}>{t('Paying late has added {a}.', { a: kes(l.lateFees) })}</p>}
              </Card>
              <Card>
                <label htmlFor="amt" className="small" style={{ fontFamily: 'var(--display)', fontWeight: 700, color: 'var(--navy)' }}>{t('How much will you pay?')}</label>
                <div className="amount-box solo"><span aria-hidden>KES</span><input id="amt" className="input amount-input" inputMode="numeric" pattern="[0-9,]*" autoComplete="off" aria-invalid={!!err && amount > 0} aria-describedby="amt-help" value={amount ? amount.toLocaleString('en-KE') : ''} onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')) || 0)} /></div>
                <p id="amt-help" className={`small amt-help ${err && amount > 0 ? 'text-bad' : 'muted'}`} role={err && amount > 0 ? 'alert' : undefined}>
                  {err && amount > 0 ? err : partialOk ? t('Any amount, up to {a}', { a: kes(l.outstanding) }) : t('This loan is paid back in one payment of {a}.', { a: kes(payoff) })}
                </p>
                <Button variant="teal" block onClick={() => setAmount(payoff)}>{t('Pay everything · {a}', { a: kes(payoff) })}</Button>
                {chips.length > 0 && (
                  <div className="chip-row" role="group" aria-label={t('Pay part of the amount')}>
                    {chips.map((v) => <button key={v} type="button" className={`pick ${amount === v ? 'on' : ''}`} aria-pressed={amount === v} onClick={() => setAmount(v)}>{kes(v)}</button>)}
                  </div>
                )}
              </Card>
              <Card><PayFrom value={payer} onChange={setPayer} ownPhone={ownPhone} /></Card>
              <Button variant="primary" size="lg" block loading={busy} disabled={!!err || !payerOk(payer)} onClick={() => setConfirming(true)}>{t('Pay {a}', { a: amount ? kes(amount) : '' })}</Button>
              <p className="fine center">{t('You will check the amount and number before anything is sent.')}</p>
              {(() => {
                const number = payer.mode === 'own' ? (ownPhone ?? t('your M-PESA number')) : payer.phone.trim();
                return (
                  <Modal open={confirming} onClose={() => setConfirming(false)} title={t('Check this')}
                    footer={<><Button variant="outline" onClick={() => setConfirming(false)}>{t('Change')}</Button><Button variant="primary" onClick={pay}>{t('Yes, pay {a}', { a: kes(amount) })}</Button></>}>
                    <dl className="kv">
                      <div className="total"><dt>{t('You are paying')}</dt><dd>{kes(amount)}</dd></div>
                      <div><dt>{t('M-PESA number')}</dt><dd>{number}</dd></div>
                      <div><dt>{amount >= payoff ? t('After this payment') : t('You will still owe')}</dt><dd>{amount >= payoff ? t('This pays it all') : kes(l.outstanding - amount)}</dd></div>
                    </dl>
                    <p className="small" style={{ margin: '.9rem 0 0' }}>{payer.mode === 'own' ? rich(t('You will receive an M-PESA prompt on <b>{a}</b>. Enter your M-PESA PIN to complete the payment.', { a: number })) : rich(t('An M-PESA prompt will be sent to <b>{a}</b>. The owner of that phone enters their M-PESA PIN to complete the payment.', { a: number }))}</p>
                    <p className="fine" style={{ margin: '.5rem 0 0' }}>{t('Nothing is taken until the M-PESA PIN is entered.')}</p>
                  </Modal>
                );
              })()}
              <p className="fine center">{t('Demo: an amount of exactly KES 999 simulates a failed payment.')}</p>
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
      <MTop back="/member/repay" title={t('What I have paid')} />
      <div className="m-content">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'payments', label: t('Payments') }, { value: 'loans', label: t('Loans') }]} />
        <Loadable q={q}>{([reps, loans]) => tab === 'payments' ? (
          reps.length === 0 ? <Card><EmptyState title={t('No payments yet')} text={t('Payments you make will appear here.')} /></Card>
            : <Card><div className="list">{reps.map((r) => <PaymentRow key={r.id} r={r} to={`/member/loans/${r.loanId}`} />)}</div></Card>
        ) : (loans.length === 0 ? <Card><EmptyState title={t('No loans yet')} /></Card> : <div className="stack-sm">{loans.map((l) => <LoanCard key={l.id} l={l} />)}</div>)}</Loadable>
        <StatementButton url="/member/statement.pdf" name="loan-statement.pdf" label={t('Download my loan statement (PDF)')} />
      </div>
    </>
  );
}
