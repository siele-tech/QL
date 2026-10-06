import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Compass, X } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useData, useToast } from './ui';

/** Demo-mode walkthrough of the member journey, with one-click demo sign-in. Only rendered when the server runs in demo mode. */
type Step = { title: string; text: string; to?: string; match: RegExp };
const MEMBER: Step[] = [
  { title: 'Sign in as a member', text: 'John Kamau · 0712345678 · PIN 1234.', to: '/member/login', match: /^\/member\/login/ },
  { title: 'See your loan offers', text: 'Home shows what you can borrow, your active loan and when it is due.', to: '/member', match: /^\/member\/?$/ },
  { title: 'View the offer and loan details', text: 'Amount, interest, fees, due date, late fee and rollover terms, before you commit.', to: '/member/borrow', match: /^\/member\/borrow/ },
  { title: 'Confirmation', text: 'Emergency Loan is approved and paid out automatically; School Fees waits for the lender.', match: /^\/member\/applications\// },
  { title: 'Your active loan', text: 'Principal, interest, fees, what you owe now, and payment history.', match: /^\/member\/loans\/./ },
  { title: 'Pay', text: 'Pay part or all, from your number or someone else’s. See the confirmation and reference.', to: '/member/repay', match: /^\/member\/repay/ },
  { title: 'Loan completed', text: 'Your behaviour score and milestones update.', to: '/member/behaviour', match: /^\/member\/behaviour/ },
  { title: 'Reminders', text: 'Due-date, overdue and rollover reminders arrive here and by SMS.', to: '/member/notifications', match: /^\/member\/notifications/ },
];

const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };

export function DemoGuide() {
  const demo = useData(() => api.get('/public/demo'), []);
  const { me, refresh, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(() => store.get('ql-guide-open') !== '0');
  const [busy, setBusy] = useState(false);
  useEffect(() => { store.set('ql-guide-open', open ? '1' : '0'); }, [open]);
  useEffect(() => {
    document.body.classList.toggle('entry-body', !loc.pathname.startsWith('/member'));
  }, [loc.pathname]);
  if (!demo.data?.enabled) return null;

  const steps = MEMBER;
  const here = steps.findIndex((s) => s.match.test(loc.pathname));
  const signInDemo = async () => {
    setBusy(true);
    try {
      const a = demo.data.accounts;
      await logout();
      await api.post('/auth/member/login', { phone: a.member.phone, pin: a.member.pin });
      await refresh();
      toast('info', `Signed in as ${a.member.name}.`);
      nav('/member');
    } catch (e: any) { toast('bad', e.message); } finally { setBusy(false); }
  };

  if (!open) return <button className="guide-fab" onClick={() => setOpen(true)}><Compass size={16} /><span className="gl">Demo guide</span> <b>{here >= 0 ? `${here + 1}/${steps.length}` : steps.length}</b></button>;
  return (
    <aside className="guide" aria-label="Demo guide">
      <header>
        <button className="close" aria-label="Hide demo guide" onClick={() => setOpen(false)}><X size={18} /></button>
        <span className="eyebrow">Demo guide</span>
        <h3>Member journey</h3>
        <p>{me?.authenticated ? `Signed in as ${me.principal?.name} · ${me.principal?.roleName}` : 'Not signed in'}</p>
      </header>
      <div className="gbody">
        {steps.map((s, i) => (
          <div key={s.title} className={`gstep ${i < here ? 'done' : ''} ${i === here ? 'here' : ''}`}>
            <span className="n">{i + 1}</span>
            <div><b>{s.title}</b><p>{s.text}</p>{s.to && i !== here && <Link to={s.to}>Go there →</Link>}</div>
          </div>
        ))}
      </div>
      <div className="gfoot">
        <span>Sign in as the demo member in one click:</span>
        <div className="row">
          <button disabled={busy} onClick={signInDemo}>{demo.data.accounts.member.name}</button>
        </div>
      </div>
    </aside>
  );
}
