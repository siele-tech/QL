import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, CalendarClock, ChevronRight, CircleCheck, Clock, Info, TrendingUp } from 'lucide-react';
import { api } from '../api';
import { Alert, Badge, Button, Card, EmptyState, Loadable, ProgressBar, SkeletonBlock, useData } from '../components/ui';
import { fmtDate, kes } from '../format';
import { days, rich, t } from '../i18n';
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
      <MTop title={<span className="hello">{q.data ? t('Hello, {a}', { a: q.data.member.firstName }) : t('Hello')}<small>{q.data?.organization?.name ?? 'QuickLoan'}</small></span>} />
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
                    <span className="label">{t('Application in progress')}</span>
                    <div className="big"><small>KES</small>{app.amount.toLocaleString('en-KE')}</div>
                    <div className="meta"><span>{app.productName}</span><Badge status={app.status} /></div>
                    <Button variant="primary" size="lg" block onClick={() => nav(`/member/applications/${app.id}`)}>{t('View application status')}</Button>
                  </div>
                ) : canApply ? (
                  <div className="hero">
                    <span className="label">{t('You can borrow up to')}</span>
                    <div className="big"><small>KES</small>{el.available.toLocaleString('en-KE')}</div>
                    <div className="meta"><span>{t('You have no loan now')}</span><span>{t('Pay back within {a}', { a: days(Math.max(...offers.map((p: any) => p.periodDays))) })}</span></div>
                    <Button variant="primary" size="lg" block onClick={() => nav('/member/borrow')}>{t('Apply for loan')}</Button>
                  </div>
                ) : (
                  <Card>
                    <h2>{t('No loan available right now')}</h2>
                    {el.blockers.map((b: string) => <p key={b} className="small" style={{ margin: '.3rem 0' }}>{b}</p>)}
                    <p className="fine" style={{ margin: '.5rem 0 0' }}>{t('Your lender decides who can borrow using its own rules and your repayment history.')}</p>
                  </Card>
                )}

                {!canApply && (loan || app) && (
                  <p className="hint-row"><Info size={16} aria-hidden />{loan ? t('You can apply again after you pay back this loan.') : t('You already have an application in progress.')}</p>
                )}

                {loan && el.products.length > 0 && (
                  <section aria-label={t('Loans you can get after you pay back')}>
                    <h2 className="group-title">{t('Loans you can get after you pay back')}</h2>
                    <div className="card offer-list">
                      {el.products.map((p: any) => (
                        <div key={p.id} className="offer-row later">
                          <span className="li-icon off" aria-hidden><Banknote size={18} /></span>
                          <span className="li-main"><span className="offer-name">{p.name}</span><span className="li-sub">{t('{a} · borrow {b}, pay back {c}', { a: days(p.periodDays), b: kes(p.example.amount), c: kes(p.example.totalRepayable) })}</span></span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {canApply && offers.length > 1 && (
                  <section aria-label={t('Your loan offers')}>
                    <h2 className="group-title">{t('Your loan offers')}</h2>
                    <div className="card offer-list">
                      {offers.map((p: any) => (
                        <Link key={p.id} to={`/member/borrow?product=${p.id}${p.offerToken ? `&offer=${p.offerToken}` : ''}`} className="offer-row">
                          <span className="li-icon" aria-hidden><Banknote size={18} /></span>
                          <span className="li-main"><span className="offer-name">{p.name}{p.offeredVia === 'OFFER' && <Badge tone="warn" label={t('Special offer')} />}</span><span className="li-sub">{t('{a} · borrow {b}, pay back {c}', { a: days(p.periodDays), b: kes(p.example.amount), c: kes(p.example.totalRepayable) })}</span></span>
                          <span className="offer-max"><span className="g-label">{t('Up to')}</span><span className="g-value">{kes(p.maxAmount)}</span></span>
                          <ChevronRight size={18} color="var(--muted)" aria-hidden />
                        </Link>
                      ))}
                    </div>
                  </section>
                )}
              </div>

              <div className="m-col">
                <Card title={t('Recent activity')} action={<Link to="/member/notifications" className="small">{t('See all')}</Link>}>
                  {h.recentActivity.length === 0 ? <EmptyState title={t('Nothing yet')} text={t('Updates about your loans will appear here.')} />
                    : <div className="list">{h.recentActivity.slice(0, 3).map((n: any) => <NotificationRow key={n.id} n={n} />)}</div>}
                </Card>

                <Link to="/member/behaviour" className="card behaviour-row" aria-label={`Loan behaviour: ${h.behaviour.score} out of 100, ${h.behaviour.level.name}. Open details.`}>
                  <span className="li-icon" aria-hidden><TrendingUp size={18} /></span>
                  <span className="li-main">
                    <span className="li-title">{t('Loan behaviour: {a} / 100', { a: h.behaviour.score })}</span>
                    <span className="li-sub">{h.behaviour.level.name}{h.behaviour.onTimeRate !== null ? ' · ' + t('{a}% paid back on time', { a: h.behaviour.onTimeRate }) : ''}{h.behaviour.streak > 1 ? ' · ' + t('{a} in a row', { a: h.behaviour.streak }) : ''}</span>
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
  const status = overdue ? t('Your payment is late') : dueToday ? t('Pay today') : loan.status === 'ROLLED_OVER' ? t('Your loan · more time given {a}×', { a: loan.rolloverCount }) : t('Your loan');
  return (
    <div className={`hero ${overdue ? 'overdue' : ''}`}>
      <div className="row between nowrap"><span className="label"><Icon size={14} style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden />{status}</span><span className="small" style={{ opacity: .85 }}>{loan.productName}</span></div>
      <div>
        <div className="small" style={{ opacity: .85 }}>{t('You owe')}</div>
        <div className="big"><small>KES</small>{loan.outstanding.toLocaleString('en-KE')}</div>
      </div>
      <div className="hero-due">
        {overdue ? <>{t('It was due on {a}.', { a: fmtDate(loan.dueDate) })}{loan.daysOverdue > 0 && <> <b>{t('That was {a} ago.', { a: days(loan.daysOverdue) })}</b></>}</> : dueToday ? <b>{t('Pay today to stay on time')}</b> : rich(t('Pay it back before <b>{a}</b> · {b} left', { a: fmtDate(loan.dueDate), b: days(loan.daysRemaining) }))}
      </div>
      <ProgressBar value={loan.progressPct} label={t('{a}% paid back', { a: loan.progressPct })} />
      {overdue && loan.lateFees > 0 && !compact && <Alert tone="bad">{t('Paying late has added {a}. Pay as soon as you can so it does not cost more.', { a: kes(loan.lateFees) })}</Alert>}
      {!compact && (
        <div className="row nowrap">
          <Button variant="primary" size="lg" className="grow" onClick={() => nav(`/member/repay/${loan.id}`)}>{t('Pay now')}</Button>
          <Button variant="outline" size="lg" className="grow" onClick={() => nav(`/member/loans/${loan.id}`)}>{t('View loan')}</Button>
        </div>
      )}
    </div>
  );
}
