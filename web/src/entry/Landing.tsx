import { Link } from 'react-router-dom';
import { ArrowRight, Smartphone } from 'lucide-react';
import { Brand } from '../components/Brand';
import { api } from '../api';
import { useData } from '../components/ui';

export function Landing() {
  const demo = useData(() => api.get('/public/demo'), []);
  return (
    <div className="entry">
      <div className="entry-inner">
        <Brand />
        <h1>Short-term loans, <span className="accent-yellow">simply</span> done.</h1>
        <p className="entry-lead">Borrow from your SACCO, MFI or credit group in minutes — with clear costs, a fair due date and repayment by M-PESA.</p>
        <div className="entry-choices">
          <Link to="/member/login" className="choice">
            <span className="choice-icon"><Smartphone size={22} /></span>
            <h2>Member</h2>
            <p>Check how much you can borrow, apply, repay by M-PESA and track your loans.</p>
            <span className="go">Sign in <ArrowRight size={16} /></span>
          </Link>
        </div>
        {demo.data?.enabled && (
          <div className="demo-strip">
            <span className="dot" />
            <div>
              <b>Demo mode.</b> Member: <code>{demo.data.accounts.member.phone}</code> / PIN <code>{demo.data.accounts.member.pin}</code>.
              {' '}More demo accounts are listed on each sign-in screen. These credentials exist only in demo mode.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
