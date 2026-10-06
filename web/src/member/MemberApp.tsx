import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Banknote, Bell, BellRing, CheckCircle2, ChevronLeft, ChevronRight, CreditCard, FileText, Gift, Home as HomeIcon, LogOut, Send, ShieldCheck, TrendingUp, User, Wallet, WifiOff, XCircle } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Brand } from '../components/Brand';
import { Alert, Button, Card, EmptyState, Loadable, useData, useToast } from '../components/ui';
import { fmtDate, kes, timeAgo } from '../format';
import { Home } from './Home';
import { Borrow, ApplicationStatus } from './Borrow';
import { LoansPage, LoanDetail, RepayPage, RepayChooser, HistoryPage, StatementButton } from './Loans';
import { BehaviourPage } from './Behaviour';
import { CreditStatusPage } from './Credit';

/** Shared member state: the unread count is fetched once and refreshed sparingly, not on every screen. */
const MemberCtx = createContext<{ unread: number; refreshUnread: (force?: boolean) => void }>({ unread: 0, refreshUnread: () => {} });
export const useMember = () => useContext(MemberCtx);

export default function MemberApp() {
  const loc = useLocation();
  const [unread, setUnread] = useState(0);
  const last = useRef(0);
  const refreshUnread = useCallback((force = false) => {
    if (!force && Date.now() - last.current < 30_000) return;
    last.current = Date.now();
    api.get('/member/notifications/unread-count').then((r) => setUnread(r.unread)).catch(() => {});
  }, []);
  useEffect(() => { refreshUnread(); }, [loc.pathname, refreshUnread]);
  useEffect(() => { document.body.classList.add('member-body'); return () => document.body.classList.remove('member-body'); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);

  return (
    <MemberCtx.Provider value={{ unread, refreshUnread }}>
      <div className="m-shell">
        <WebHeader />
        <OfflineBanner />
        <main className="m-main">
          <Routes>
            <Route index element={<Home />} />
            <Route path="dashboard" element={<Navigate to="/member" replace />} />
            <Route path="borrow" element={<Borrow />} />
            <Route path="applications/:id" element={<ApplicationStatus />} />
            <Route path="loans" element={<LoansPage />} />
            <Route path="loans/:id" element={<LoanDetail />} />
            <Route path="repay" element={<RepayChooser />} />
            <Route path="repay/:id" element={<RepayPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="behaviour" element={<BehaviourPage />} />
            <Route path="credit" element={<CreditStatusPage />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="profile" element={<Profile />} />
            <Route path="offer/:token" element={<OfferLanding />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </main>
        <nav className="m-nav" aria-label="Main">
          <NavLink to="/member" end><HomeIcon size={22} aria-hidden /><span>Home</span></NavLink>
          <NavLink to="/member/loans"><Wallet size={22} aria-hidden /><span>Loans</span></NavLink>
          <NavLink to="/member/repay"><CreditCard size={22} aria-hidden /><span>Repay</span></NavLink>
          <NavLink to="/member/profile"><User size={22} aria-hidden /><span>Profile</span></NavLink>
        </nav>
      </div>
    </MemberCtx.Provider>
  );
}

const NAV_LINKS = [
  { to: '/member', label: 'Home', end: true }, { to: '/member/loans', label: 'My loans' }, { to: '/member/repay', label: 'Repay' },
  { to: '/member/profile', label: 'Profile' },
];

/** Desktop/tablet header (hidden on phones, where the bottom tab bar is used instead). */
function WebHeader() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  return (
    <header className="m-web">
      <Link to="/member" className="m-web-brand"><Brand sub={me?.organization?.name ?? 'Member'} /></Link>
      <nav aria-label="Member">
        {NAV_LINKS.map((l) => <NavLink key={l.to} to={l.to} end={l.end}>{l.label}</NavLink>)}
      </nav>
      <div className="m-web-end">
        <span className="m-web-who"><span className="avatar">{me?.principal?.name?.split(' ').map((s) => s[0]).slice(0, 2).join('')}</span>{me?.principal?.name}</span>
        <button className="btn btn-outline btn-sm" onClick={async () => { await logout(); nav('/', { replace: true }); }}><LogOut size={14} aria-hidden />Sign out</button>
      </div>
    </header>
  );
}

/** Tells the member plainly when the phone has no connection. */
function OfflineBanner() {
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false);
  useEffect(() => {
    const on = () => setOffline(false), off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (!offline) return null;
  return <div className="offline" role="status"><WifiOff size={16} aria-hidden /> You are offline. Check your data or Wi-Fi.</div>;
}

/** Screen header: a page title, with a back button on inner screens. */
/** The bell at the top right of every main screen, with the number of unread notifications. */
function NotificationBell() {
  const { unread } = useMember();
  return (
    <Link to="/member/notifications" className="icon-btn bell" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
      <Bell size={22} aria-hidden />{unread > 0 && <span className="dot-badge" aria-hidden>{unread > 9 ? '9+' : unread}</span>}
    </Link>
  );
}

export function MTop({ title, back, right }: { title?: ReactNode; back?: string | true; right?: ReactNode }) {
  const nav = useNavigate();
  const onNotifications = useLocation().pathname.endsWith('/notifications');
  return (
    <header className="m-top">
      {back ? (
        <div className="m-top-lead"><button type="button" className="back" aria-label="Back" onClick={() => (back === true ? nav(-1) : nav(back))}><ChevronLeft size={24} aria-hidden /></button><h1 className="m-title">{title}</h1></div>
      ) : <h1 className="m-title">{title}</h1>}
      {right ?? (!back && !onNotifications ? <NotificationBell /> : null)}
    </header>
  );
}

/** Icon, tone and a short text label per notification type — status is never shown by colour alone. */
const NOTIF: Record<string, { icon: ReactNode; cls: string; label: string }> = {
  APPLICATION_SUBMITTED: { icon: <Send size={18} />, cls: '', label: 'Application' },
  APPLICATION_APPROVED: { icon: <CheckCircle2 size={18} />, cls: 'good', label: 'Approved' },
  APPLICATION_REJECTED: { icon: <XCircle size={18} />, cls: 'bad', label: 'Not approved' },
  LOAN_DISBURSED: { icon: <Banknote size={18} />, cls: 'good', label: 'Money sent' },
  DISBURSEMENT_DELAYED: { icon: <AlertTriangle size={18} />, cls: 'gold', label: 'Delayed' },
  PAYMENT_RECEIVED: { icon: <CheckCircle2 size={18} />, cls: 'good', label: 'Payment' },
  PAYMENT_FAILED: { icon: <XCircle size={18} />, cls: 'bad', label: 'Payment failed' },
  LOAN_REPAID: { icon: <CheckCircle2 size={18} />, cls: 'good', label: 'Loan completed' },
  LOAN_ROLLED_OVER: { icon: <BellRing size={18} />, cls: 'gold', label: 'Rolled over' },
  LATE_FEE_ADDED: { icon: <AlertTriangle size={18} />, cls: 'bad', label: 'Late fee' },
  LOAN_DEFAULTED: { icon: <AlertTriangle size={18} />, cls: 'bad', label: 'Overdue' },
  REMINDER: { icon: <BellRing size={18} />, cls: 'gold', label: 'Reminder' },
  OFFER: { icon: <Gift size={18} />, cls: '', label: 'Loan offer' },
  CRB_STATUS: { icon: <ShieldCheck size={18} />, cls: '', label: 'CRB status' },
};
export const notifIcon = (t: string, title = '') => {
  const n = NOTIF[t] ?? { icon: <Bell size={18} />, cls: '', label: 'Update' };
  if (t === 'REMINDER' && /past due|overdue|final/i.test(title)) return { ...n, icon: <AlertTriangle size={18} />, cls: 'bad', label: 'Overdue' };
  if (t === 'REMINDER' && /due today/i.test(title)) return { ...n, label: 'Due today' };
  if (t === 'REMINDER' && /due in/i.test(title)) return { ...n, label: 'Due soon' };
  return n;
};

/** One notification row, shared by Home and the notifications screen. */
export function NotificationRow({ n, onOpen }: { n: any; onOpen?: (n: any) => void }) {
  const ic = notifIcon(n.type, n.title);
  const unread = !n.read_at;
  const body = (
    <>
      <span className={`li-icon ${ic.cls}`} aria-hidden>{ic.icon}</span>
      <span className="li-main">
        <span className="n-meta"><span className="n-type">{ic.label}</span>{unread && <span className="n-new">New</span>}<span className="n-time">{timeAgo(n.created_at)}</span></span>
        <span className="li-title">{n.title}</span>
        <span className="li-sub">{n.body}</span>
      </span>
      {n.link && <ChevronRight size={18} color="var(--muted)" aria-hidden />}
    </>
  );
  return onOpen
    ? <button type="button" className={`list-item notif ${unread ? 'unread' : ''}`} onClick={() => onOpen(n)}>{body}</button>
    : <div className={`list-item notif ${unread ? 'unread' : ''}`}>{body}</div>;
}

function Notifications() {
  const q = useData(() => api.get<any[]>('/member/notifications'), [], 'm:notifications');
  const { refreshUnread } = useMember();
  const nav = useNavigate();
  const markAll = async () => { await api.post('/member/notifications/read-all').catch(() => {}); await q.reload(true); refreshUnread(true); };
  const open = async (n: any) => {
    if (!n.read_at) { await api.post(`/member/notifications/${n.id}/read`).catch(() => {}); refreshUnread(true); }
    if (n.link) nav(n.link); else q.reload(true);
  };
  const today = new Date().toDateString();
  return (
    <>
      <MTop back="/member" title="Notifications" />
      <div className="m-content">
        <Loadable q={q}>{(list) => {
          if (list.length === 0) return <Card><EmptyState icon={<Bell size={22} />} title="No notifications yet" text="Updates about your applications, loans and payments will appear here." /></Card>;
          const unread = list.filter((n) => !n.read_at).length;
          const groups: [string, any[]][] = [['Today', list.filter((n) => new Date(n.created_at).toDateString() === today)], ['Earlier', list.filter((n) => new Date(n.created_at).toDateString() !== today)]];
          return (
            <>
              <div className="row between">
                <span className="small muted">{unread ? `${unread} unread` : 'All caught up'}</span>
                {unread > 0 && <Button variant="outline" size="sm" onClick={markAll}>Mark all as read</Button>}
              </div>
              {groups.filter(([, items]) => items.length).map(([label, items]) => (
                <section key={label} aria-label={label}>
                  <h2 className="group-title">{label}</h2>
                  <Card><div className="list">{items.map((n) => <NotificationRow key={n.id} n={n} onOpen={open} />)}</div></Card>
                </section>
              ))}
            </>
          );
        }}</Loadable>
        <p className="fine center">Important notifications are also sent to your phone by SMS.</p>
      </div>
    </>
  );
}

function Profile() {
  const q = useData(() => api.get('/member/profile'), [], 'm:profile');
  const { logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const signOut = async () => { await logout(); nav('/', { replace: true }); };
  const MENU: [string, string, ReactNode][] = [
    ['/member/behaviour', 'My loan behaviour', <TrendingUp size={18} key="a" />], ['/member/credit', 'My CRB status', <ShieldCheck size={18} key="b" />],
    ['/member/history', 'Repayment history', <FileText size={18} key="c" />],
  ];
  return (
    <>
      <MTop title="Profile" />
      <div className="m-content">
        <Loadable q={q}>{(p) => (
          <div className="m-cols">
            <div className="m-col">
              <Card>
                <div className="row nowrap" style={{ marginBottom: '.8rem' }}>
                  <span className="avatar" style={{ width: 52, height: 52, fontSize: 19 }} aria-hidden>{p.name?.split(' ').map((s: string) => s[0]).slice(0, 2).join('')}</span>
                  <div className="grow"><h2 style={{ margin: 0 }}>{p.name}</h2><div className="small muted">{p.organization.name}</div></div>
                </div>
                <dl className="kv">
                  <div><dt>Phone number</dt><dd>{p.phone}</dd></div>
                  <div><dt>ID number</dt><dd>{p.idNumber}</dd></div>
                  <div><dt>SACCO / lender</dt><dd>{p.organization.name}</dd></div>
                  <div><dt>M-PESA number for loans</dt><dd>{p.disbursementPhone}</dd></div>
                </dl>
                <p className="fine" style={{ marginTop: '.7rem' }}>These details come from your SACCO and cannot be changed here. To correct anything, including your phone number, contact your SACCO.</p>
              </Card>
            </div>
            <div className="m-col">
              <Card>
                <div className="list">
                  {MENU.map(([to, label, icon]) => (
                    <Link key={to} to={to} className="list-item"><span className="li-icon" aria-hidden>{icon}</span><span className="li-main"><span className="li-title">{label}</span></span><ChevronRight size={18} color="var(--muted)" aria-hidden /></Link>
                  ))}
                </div>
              </Card>
              <StatementButton url="/member/statement.pdf" name="loan-statement.pdf" label="Download my loan statement (PDF)" />
              <ChangePin onDone={() => toast('good', 'Your PIN has been changed.')} />
              <Button variant="danger" block icon={<LogOut size={16} aria-hidden />} onClick={signOut}>Sign out</Button>
            </div>
          </div>
        )}</Loadable>
      </div>
    </>
  );
}

function ChangePin({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(''), [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/member/pin', { currentPin: cur, newPin: next }); setOpen(false); setCur(''); setNext(''); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (!open) return <Button variant="outline" block onClick={() => setOpen(true)}>Change PIN</Button>;
  return (
    <Card title="Change PIN">
      {err && <div style={{ marginBottom: '.6rem' }}><Alert tone="bad">{err}</Alert></div>}
      <div className="field"><label htmlFor="pin-cur">Current PIN</label><input id="pin-cur" className="input pin-input" type="password" inputMode="numeric" autoComplete="current-password" maxLength={4} value={cur} onChange={(e) => setCur(e.target.value.replace(/\D/g, ''))} /></div>
      <div className="field"><label htmlFor="pin-new">New PIN (4 digits)</label><input id="pin-new" className="input pin-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, ''))} /></div>
      <div className="row nowrap"><Button variant="outline" className="grow" onClick={() => setOpen(false)}>Cancel</Button><Button className="grow" loading={busy} disabled={cur.length !== 4 || next.length !== 4} onClick={save}>Save PIN</Button></div>
    </Card>
  );
}

/** SMS offer link lands here: records "opened" then hands over to the application. */
function OfferLanding() {
  const { token } = useParams();
  const q = useData(() => api.get(`/member/offers/${token}`), [token]);
  const nav = useNavigate();
  return (
    <>
      <MTop back="/member" title="Loan offer" />
      <div className="m-content m-narrow">
        <Loadable q={q}>{(o) => (
          <>
            <div className="hero">
              <span className="label">{o.product.name} · offer for you</span>
              <div className="big"><small>KES</small>{o.amount.toLocaleString('en-KE')}</div>
              <div className="meta"><span>Up to {o.product.period_days} days</span><span>Valid until {fmtDate(o.expiresAt)}</span></div>
              {o.status === 'APPLIED' ? <Alert tone="good">You have already applied using this offer.</Alert>
                : o.status === 'EXPIRED' ? <Alert tone="warn">This offer has expired.</Alert>
                : <Button variant="primary" block size="lg" onClick={() => nav(`/member/borrow?product=${o.product.id}&offer=${token}&amount=${o.amount}`)}>Apply for this loan</Button>}
            </div>
            {o.terms && (
              <Card title="Loan terms">
                <dl className="kv">
                  <div><dt>Interest</dt><dd>{o.terms.interestText}</dd></div>
                  <div><dt>Fees</dt><dd>{o.terms.feeText}</dd></div>
                  <div><dt>Loan period</dt><dd>{o.terms.periodDays} days</dd></div>
                  <div><dt>Example</dt><dd>Borrow {kes(o.example.amount)}, repay {kes(o.example.totalRepayable)}</dd></div>
                  <div><dt>Late-payment fee</dt><dd>{o.terms.lateFeeText ?? 'None'}</dd></div>
                  <div><dt>Rollover</dt><dd>{o.terms.rolloverEnabled ? `Up to ${o.terms.rolloverMax} times` : 'Not allowed'}</dd></div>
                </dl>
              </Card>
            )}
            <p className="fine">An offer shows the most you may borrow. Borrow only what you need. You will see the full cost and due date before you apply.</p>
          </>
        )}</Loadable>
      </div>
    </>
  );
}
