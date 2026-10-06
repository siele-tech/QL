import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { api } from '../api';
import { Alert, Button, Card, KeyValue, Loadable, clearDataCache, useData, useToast } from '../components/ui';
import { fmtDate, kes } from '../format';
import { MTop } from './MemberApp';
import { PayFrom, payerBody, payerOk, type Payer } from './Loans';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plain-language reading of a CRB result: what it means, and what the member can do next. */
function explain(latest: any): { means: string; next: string } {
  const s = latest.summary;
  if (s?.hasAdverseListing) return {
    means: 'The bureau shows a loan that was not repaid as agreed (a negative listing). Lenders see this when you apply, and it can lead to a loan being declined.',
    next: 'Clear the listed debt with the lender that reported it, then ask them for a clearance letter. Your record updates after they confirm to the bureau.',
  };
  if (s?.nonPerformingAccounts > 0) return {
    means: 'You are behind on at least one credit account. You are not listed as a defaulter, but lenders can see the late payments.',
    next: 'Bring the late account up to date. Paying it before it is listed protects your record.',
  };
  if (latest.standing?.tone === 'good') return {
    means: 'Your record is clean: no negative listings and no accounts in arrears. Lenders see you as a low-risk borrower.',
    next: 'Nothing to fix. Keep repaying every loan on or before its due date.',
  };
  if (latest.standing?.tone === 'warn') return {
    means: 'Your record is acceptable but not strong. You have no negative listing, but your history is short or has some late payments.',
    next: 'Repay on time for the next few months and avoid taking several loans at once. Your standing improves as your history grows.',
  };
  return {
    means: 'Your score is low. Lenders may ask for more information or decline a loan.',
    next: 'Pay any overdue amounts first, then repay on time. Scores recover gradually with a clean record.',
  };
}

/**
 * A member checks their own CRB status and pays the CRB fee. Nothing is checked until the fee is
 * paid. The result is shared with their lender, who then need not check (or pay) again.
 */
export function CreditStatusPage() {
  const q = useData(() => api.get('/member/crb'), [], 'm:crb');
  const toast = useToast();
  const [consent, setConsent] = useState(false);
  const [payer, setPayer] = useState<Payer>({ mode: 'own', phone: '' });
  const [phase, setPhase] = useState<'idle' | 'starting' | 'paying' | 'checking'>('idle');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    setPhase('starting'); setErr(null);
    try {
      const before = q.data?.latest?.id ?? null;
      const r = await api.post('/member/crb/check', { consent, ...payerBody(payer) });
      if (r.status === 'PAYMENT') {
        setSentTo(r.payment.phone); setPhase('paying');
        let p = r.payment;
        for (let i = 0; i < 40 && p.status === 'PENDING'; i++) { await wait(1000); p = await api.get(`/member/payments/${p.id}`); }
        if (p.status !== 'SUCCESS') { setErr(p.status === 'FAILED' ? `${p.message}${p.reason ? ` (${p.reason})` : ''}` : 'Payment pending: we have not received a confirmation from M-PESA yet. If you entered your PIN, your result will appear here shortly. Please do not pay again.'); setPhase('idle'); return; }
        setPhase('checking');
        // The check runs as soon as the payment is confirmed; wait for the new result.
        let st = await api.get('/member/crb');
        for (let i = 0; i < 15 && (st.latest?.id ?? null) === before && !st.hasCredit; i++) { await wait(800); st = await api.get('/member/crb'); }
        clearDataCache(); q.setData(st);
        if ((st.latest?.id ?? null) === before) setErr('We received your payment but could not reach the credit bureau. Your next attempt is free.');
        else toast('good', 'Your CRB status is ready.');
      } else { q.setData(r.crb); toast('good', 'Your CRB status is ready.'); }
    } catch (e: any) { setErr(e.message); }
    setPhase('idle');
  };

  if (phase === 'paying' || phase === 'checking') return (
    <><MTop title="My CRB status" /><div className="m-content m-narrow"><Card><div className="center" style={{ padding: '1.5rem .5rem' }} role="status">
      {phase === 'paying' ? <Smartphone size={40} color="var(--teal)" aria-hidden /> : <ShieldCheck size={40} color="var(--teal)" aria-hidden />}
      <h2 style={{ marginTop: '.6rem' }}>{phase === 'paying' ? 'Check your phone' : 'Payment received'}</h2>
      <p className="small muted">{phase === 'paying' ? <>We sent an M-PESA request for the CRB fee to <b>{sentTo}</b>. Enter the M-PESA PIN to confirm.</> : 'Checking your status with the credit bureau…'}</p>
      <div className="spinner-row"><Loader2 className="spin" size={18} />{phase === 'paying' ? 'Waiting for M-PESA…' : 'Almost done…'}</div>
    </div></Card></div></>
  );

  return (
    <>
      <MTop back="/member/profile" title="My CRB status" />
      <div className="m-content m-narrow">
        <Loadable q={q}>{(c) => (
          <>
            {err && <Alert tone="bad">{err}</Alert>}
            <Card>
              {c.latest ? (
                <div className="center">
                  <ShieldCheck size={30} color="var(--teal)" aria-hidden />
                  <div className="small muted" style={{ marginTop: '.3rem' }}>Your CRB status</div>
                  {c.latest.standing ? <h2 style={{ margin: '.2rem 0 .1rem', fontSize: '1.5rem' }}>{c.latest.standing.label}</h2> : <h2 style={{ margin: '.2rem 0 .1rem' }}>Check not completed</h2>}
                  {c.latest.score != null && <div className="small">CRB score: <b className="num">{c.latest.score}</b></div>}
                  <p className="small muted" style={{ margin: '.3rem 0 0' }}>Checked {fmtDate(c.latest.checkedAt)} by {c.latest.checkedBy === 'You' ? 'you' : 'your lender'}</p>
                </div>
              ) : (
                <div className="center">
                  <ShieldCheck size={30} color="var(--muted)" aria-hidden />
                  <h2 style={{ marginTop: '.4rem' }}>Not checked yet</h2>
                  <p className="small muted" style={{ margin: 0 }}>The credit reference bureau (CRB) keeps a record of how people repay loans across all lenders. Check yours to see where you stand.</p>
                </div>
              )}
            </Card>
            {c.latest?.score != null && (() => { const x = explain(c.latest); return (
              <Card>
                <h3 className="group-title" style={{ marginTop: 0 }}>What this means</h3>
                <p className="small" style={{ margin: '0 0 .9rem' }}>{x.means}</p>
                <h3 className="group-title">What to do next</h3>
                <p className="small" style={{ margin: 0 }}>{x.next}</p>
              </Card>
            ); })()}
            {c.latest?.summary && (
              <Card title="What the bureau shows">
                <KeyValue items={[
                  ['Open credit accounts', String(c.latest.summary.openAccounts)], ['Accounts in arrears', String(c.latest.summary.nonPerformingAccounts)],
                  ['Listed as a defaulter', c.latest.summary.hasAdverseListing ? 'Yes' : 'No'], ['Reference', c.latest.reference ?? '—'],
                ]} />
                {c.latest.simulated && <p className="fine" style={{ margin: '.5rem 0 0' }}>Demo result: the credit bureau is not connected yet.</p>}
              </Card>
            )}
            <Alert tone="info">Your lender can see this result, so they do not need to check your CRB again when you apply for a loan. This is separate from your <Link to="/member/behaviour">loan behaviour score</Link>.</Alert>
            {!c.enabled ? <p className="fine center">Your lender has not switched on self-checks. Contact them to update your CRB status.</p>
              : !c.canCheckNow ? <p className="fine center">You can check again on {fmtDate(c.nextCheckDate)}. Checks are limited to once every {c.intervalDays} days.</p>
              : (
                <Card title={c.latest ? 'Check again' : 'Check my CRB status'}>
                  {c.hasCredit ? <Alert tone="good">You have already paid for a check that could not be completed. This one is free.</Alert>
                    : c.feeKes > 0 ? <p className="small" style={{ marginTop: 0 }}>The credit bureau charges a fee of <b>{kes(c.feeKes)}</b> for each check. You pay it by M-PESA; the check runs as soon as the payment is confirmed. If the payment fails, nothing is checked and nothing is charged.</p>
                    : <p className="small muted" style={{ marginTop: 0 }}>This check is free.</p>}
                  {c.feeDueNow > 0 && <PayFrom value={payer} onChange={setPayer} ownPhone={c.phone} />}
                  {!c.hasConsent && <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> <span>I allow my lender to check my record with a licensed credit reference bureau.</span></label>}
                  <div style={{ marginTop: '.8rem' }}>
                    <Button variant="primary" size="lg" block loading={phase === 'starting'} disabled={(!c.hasConsent && !consent) || (c.feeDueNow > 0 && !payerOk(payer))} onClick={check}>
                      {c.feeDueNow > 0 ? `Pay ${kes(c.feeDueNow)} and check` : 'Check my CRB status'}
                    </Button>
                  </div>
                </Card>
              )}
            {c.history.length > 1 && (
              <Card title="Earlier checks">
                <div className="list">{c.history.slice(1).map((h: any) => (
                  <div key={h.id} className="list-item"><span className="li-main"><span className="li-title">{h.status === 'COMPLETED' ? `Score ${h.score}` : 'Check could not be completed'}</span><span className="li-sub">{fmtDate(h.checkedAt)} · by {h.checkedBy === 'You' ? 'you' : 'your lender'}{h.feePaid ? ` · you paid ${kes(h.feePaid)}` : ''}</span></span></div>
                ))}</div>
              </Card>
            )}
          </>
        )}</Loadable>
      </div>
    </>
  );
}
