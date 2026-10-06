import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarClock, ChevronRight, CircleCheck, Clock, TrendingUp } from 'lucide-react';
import { api } from '../api';
import { Alert, Badge, Button, Card, EmptyState, Loadable, ProgressBar, SkeletonBlock, useData } from '../components/ui';
import { fmtDate, kes, plural } from '../format';
import { MTop, NotificationRow } from './MemberApp';

/**
 * Home answers, in this order: do I have a loan and what do I owe → when do I pay → how much can I
 * borrow → can I apply → what happened recently → how am I doing.
 */
export function Home() {
  const q = useData(() => api.get('/member/home'), [], 'm:home');
  const nav = useNavigate();
  return (
    <>
      <MTop title={<span className="hello">{q.data ? `Hello, ${q.data.member.firstName}` : 'Hello'}<small>{q.data?.organization?.name ?? 'QuickLoan'}</small></span>} />
      <div className="m-content">
        <Loadable q={q} skeleton={<><div className="hero skeleton-hero" aria-hidden /><SkeletonBlock rows={4} /></>}>{(h) => {
          const loan = h.currentLoan, app = h.pendingApplication, el = h.eligibility;
          const offers = el.products.filter((p: any) => p.eligible);
          const overdue = loan && (loan.daysOverdue > 0 || ['OVERDUE', 'DEFAULTED'].includes(loan.status));
          const canApply = !loan && !app && el.canBorrow;
          return (
            <div className="m-cols">
              <div className="m-col">
                {loan ? <CurrentLoanHero loan={loan} /> : app ? (
                  <div className="hero">
                    <span className="label">Application in progress</span>
                    <div className="big"><small>KES</small>{app.amount.toLocaleString('en-KE')}</div>
                    <div className="meta"><span>{app.productName}</span><Badge status={app.status} /></div>
                    <Button variant="primary" size="lg" block onClick={() => nav(`/member/applications/${app.id}`)}>View application status</Button>
                  </div>
                ) : canApply ? (
                  <div className="hero">
                    <span className="label">You can borrow up to</span>
                    <div className="big"><small>KES</small>{el.available.toLocaleString('en-KE')}</div>
                    <div className="meta"><span>No active loan</span><span>Repay within {Math.max(...offers.map((p: any) => p.periodDays))} days</span></div>
                    <Button variant="primary" size="lg" block onClick={() => nav('/member/borrow')}>Apply for loan</Button>
                  </div>
                ) : (
                  <Card>
                    <h2>No loan available right now</h2>
                    {el.blockers.map((b: string) => <p key={b} className="small" style={{ margin: '.3rem 0' }}>{b}</p>)}
                    <p className="fine" style={{ margin: '.5rem 0 0' }}>Your lender decides who can borrow using its own rules and your repayment history.</p>
                  </Card>
                )}

                {!canApply && (loan || app) && (
                  <div className="apply-row">
                    <Button variant="outline" block disabled>Apply for loan</Button>
                    <p className="fine center" style={{ margin: '.4rem 0 0' }}>{loan ? 'You can apply again after you repay your current loan.' : 'You already have an application in progress.'}</p>
                  </div>
                )}

                {loan && el.products.length > 0 && (
                  <section className="stack-sm" aria-label="Loans you can borrow after you repay">
                    <h2 className="group-title">Loans you can borrow after you repay</h2>
                    {el.products.map((p: any) => (
                      <div key={p.id} className="offer-card later">
                        <b>{p.name}</b>
                        <span className="small muted">{p.periodDays} days · borrow {kes(p.example.amount)}, repay {kes(p.example.totalRepayable)}</span>
                      </div>
                    ))}
                  </section>
                )}

                {canApply && offers.length > 1 && (
                  <section className="stack-sm" aria-label="Your loan offers">
                    <h2 className="group-title">Your loan offers</h2>
                    {offers.map((p: any) => (
                      <Link key={p.id} to={`/member/borrow?product=${p.id}${p.offerToken ? `&offer=${p.offerToken}` : ''}`} className="offer-card">
                        <span className="row between nowrap"><b>{p.name}</b>{p.offeredVia === 'OFFER' && <Badge tone="warn" label="Special offer" />}</span>
                        <span className="amt">Up to {kes(p.maxAmount)}</span>
                        <span className="small muted">{p.periodDays} days · borrow {kes(p.example.amount)}, repay {kes(p.example.totalRepayable)}</span>
                      </Link>
                    ))}
                  </section>
                )}
              </div>

              <div className="m-col">
                <Card title="Recent activity" action={<Link to="/member/notifications" className="small">See all</Link>}>
                  {h.recentActivity.length === 0 ? <EmptyState title="Nothing yet" text="Updates about your loans will appear here." />
                    : <div className="list">{h.recentActivity.slice(0, 3).map((n: any) => <NotificationRow key={n.id} n={n} />)}</div>}
                </Card>

                <Link to="/member/behaviour" className="card behaviour-row" aria-label={`Loan behaviour: ${h.behaviour.score} out of 100, ${h.behaviour.level.name}. Open details.`}>
                  <span className="li-icon" aria-hidden><TrendingUp size={18} /></span>
                  <span className="li-main">
                    <span className="li-title">Loan behaviour: {h.behaviour.score} / 100</span>
                    <span className="li-sub">{h.behaviour.level.name}{h.behaviour.onTimeRate !== null ? ` · ${h.behaviour.onTimeRate}% repaid on time` : ''}{h.behaviour.streak > 1 ? ` · ${h.behaviour.streak} in a row` : ''}</span>
                  </span>
                  <ChevronRight size={18} color="var(--muted)" aria-hidden />
                </Link>
              </div>
            </div>
          );
        }}</Loadable>
      </div>
    </>
  );
}

/** The member's active loan: what they owe, by when, and the way to pay. */
export function CurrentLoanHero({ loan, compact }: { loan: any; compact?: boolean }) {
  const nav = useNavigate();
  const overdue = loan.daysOverdue > 0 || loan.status === 'OVERDUE' || loan.status === 'DEFAULTED';
  const dueToday = !overdue && loan.daysRemaining === 0;
  const Icon = overdue ? AlertTriangle : dueToday ? CalendarClock : loan.amountPaid > 0 ? CircleCheck : Clock;
  const status = overdue ? 'Payment overdue' : dueToday ? 'Due today' : loan.status === 'ROLLED_OVER' ? `Active loan · rolled over ${loan.rolloverCount}×` : 'Active loan';
  return (
    <div className={`hero ${overdue ? 'overdue' : ''}`}>
      <div className="row between nowrap"><span className="label"><Icon size={14} style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden />{status}</span><span className="small" style={{ opacity: .85 }}>{loan.productName}</span></div>
      <div>
        <div className="small" style={{ opacity: .85 }}>You owe</div>
        <div className="big"><small>KES</small>{loan.outstanding.toLocaleString('en-KE')}</div>
      </div>
      <div className="hero-due">
        {overdue ? <>Was due {fmtDate(loan.dueDate)} · <b>{plural(loan.daysOverdue, 'day')} overdue</b></> : dueToday ? <b>Pay today to stay on time</b> : <>Pay by <b>{fmtDate(loan.dueDate)}</b> · {plural(loan.daysRemaining, 'day')} left</>}
      </div>
      <ProgressBar value={loan.progressPct} label={`${loan.progressPct}% repaid`} />
      {overdue && loan.lateFees > 0 && !compact && <Alert tone="bad">A late fee of {kes(loan.lateFees)} has been added. Pay as soon as you can to avoid further charges.</Alert>}
      {!compact && (
        <div className="row nowrap">
          <Button variant="primary" size="lg" className="grow" onClick={() => nav(`/member/repay/${loan.id}`)}>Pay now</Button>
          <Button variant="outline" size="lg" className="grow" onClick={() => nav(`/member/loans/${loan.id}`)}>View loan</Button>
        </div>
      )}
    </div>
  );
}
