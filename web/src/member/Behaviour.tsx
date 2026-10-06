import { Link } from 'react-router-dom';
import { Award, Check, Lock } from 'lucide-react';
import { api } from '../api';
import { Card, KeyValue, Loadable, ProgressBar, useData } from '../components/ui';
import { ScoreLine, ScoreRing } from '../components/charts';
import { fmtDate, kes, plural } from '../format';
import { MTop } from './MemberApp';

export function BehaviourPage() {
  const q = useData(() => api.get('/member/behaviour'), [], 'm:behaviour');
  return (
    <>
      <MTop back="/member" title="My loan behaviour" />
      <div className="m-content">
        <Loadable q={q}>{(b) => (
          <>
            <Card>
              <div className="center">
                <ScoreRing score={b.score} />
                <h2 style={{ marginTop: '.6rem' }}>{b.band.label}</h2>
                <p className="small muted" style={{ margin: 0 }}>Your repayment score, out of 100. It reflects how you repay your loans here. It is <b>not</b> your CRB credit score. <Link to="/member/credit">See my CRB status</Link></p>
              </div>
            </Card>
            <Card title="Your level">
              <ol className="levels" aria-label={`Level ${b.level.index + 1} of ${b.level.total}: ${b.level.name}`}>
                {Array.from({ length: b.level.total }).map((_, i) => <li key={i} className={i < b.level.index ? 'done' : i === b.level.index ? 'here' : ''} aria-hidden>{i < b.level.index ? <Check size={14} /> : i + 1}</li>)}
              </ol>
              <div className="row between" style={{ marginTop: '.7rem' }}><b className="lc-name">{b.level.name}</b><span className="small muted">Level {b.level.index + 1} of {b.level.total}</span></div>
              <p className="small" style={{ margin: '.2rem 0 0' }}>{b.level.about}</p>
              {b.level.next ? (
                <div style={{ marginTop: '.8rem' }}>
                  <div className="row between small" style={{ marginBottom: '.3rem' }}><span className="muted">Next level: {b.level.next.name}</span><b>{b.level.next.progressPct}%</b></div>
                  <ProgressBar value={b.level.next.progressPct} label={`Progress to ${b.level.next.name}`} />
                  <p className="small" style={{ margin: '.5rem 0 0' }}>{b.level.next.hint}</p>
                </div>
              ) : <p className="small" style={{ margin: '.6rem 0 0' }}>You are at the highest level. Keep repaying on time to stay here.</p>}
              <p className="fine" style={{ margin: '.6rem 0 0' }}>Levels are earned by repaying on time, not by borrowing more.</p>
            </Card>
            <div className="stat-grid">
              <div className="stat"><span className="num">{b.onTimeRate === null ? '—' : `${b.onTimeRate}%`}</span><span>Repaid on time</span></div>
              <div className="stat"><span className="num">{b.streak}</span><span>{b.streak === 1 ? 'Loan' : 'Loans'} on time in a row</span></div>
              <div className="stat"><span className="num">{b.completedLoans}</span><span>Completed loans</span></div>
              <div className="stat"><span className="num">{b.early}</span><span>Repaid early</span></div>
              <div className="stat"><span className="num">{b.late}</span><span>Repaid late</span></div>
              <div className={`stat ${b.overdue ? 'bad' : ''}`}><span className="num">{b.overdue}</span><span>Overdue now</span></div>
            </div>
            {b.defaulted > 0 && <p className="small text-bad" style={{ margin: 0 }}>{plural(b.defaulted, 'loan')} went into default. Clearing overdue balances is the first step to rebuilding your record.</p>}
            <Card title="Milestones">
              <div className="list">{b.achievements.list.map((a: any) => (
                <div key={a.key} className="list-item">
                  <span className={`li-icon ${a.earned ? 'gold' : 'off'}`} aria-hidden>{a.earned ? <Award size={18} /> : <Lock size={16} />}</span>
                  <span className="li-main achv">
                    <span className="li-title">{a.title}</span><span className="li-sub">{a.description}</span>
                    {!a.earned && <span style={{ marginTop: '.35rem' }}><ProgressBar value={(a.progress / a.target) * 100} tone="yellow" label={`${a.title} progress`} /></span>}
                  </span>
                  <span className="li-end tiny muted">{a.earned ? <>Earned{a.earnedAt ? <><br />{fmtDate(a.earnedAt, { month: 'short', year: 'numeric' })}</> : null}</> : `${a.progress} of ${a.target}`}</span>
                </div>
              ))}</div>
              <p className="small" style={{ margin: '.6rem 0 0', color: 'var(--teal-dark)' }}>{b.achievements.tip}</p>
            </Card>
            {b.history.length > 1 && <Card title="Score over time"><ScoreLine points={b.history} /></Card>}
            <Card title="Borrowing limit">
              <KeyValue items={[['Current borrowing limit', kes(b.limit)], ['Available now', kes(b.available)], ['Behaviour', `${b.score} / 100`]]} />
              <p className="fine" style={{ margin: '.5rem 0 0' }}>Your borrowing limit is reviewed based on your lender’s eligibility rules and repayment history. A higher score does not guarantee a higher limit.</p>
            </Card>
          </>
        )}</Loadable>
      </div>
    </>
  );
}
