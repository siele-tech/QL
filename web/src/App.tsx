import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireMember, useAuth } from './auth';
import { FullPageSpinner } from './components/ui';
import { Landing } from './entry/Landing';
import { MemberLogin } from './entry/Login';
import { Activate, ActivateHelp } from './entry/Activate';
import { ResetPin } from './entry/ResetPin';
import { DemoGuide } from './components/DemoGuide';

const MemberApp = lazy(() => import('./member/MemberApp'));

export function App() {
  const { me } = useAuth();
  if (!me) return <FullPageSpinner />;
  const member = me.authenticated && me.principal?.type === 'MEMBER';
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        <Route path="/" element={member ? <Navigate to="/member" replace /> : <Landing />} />
        <Route path="/member/login" element={member ? <Navigate to="/member" replace /> : <MemberLogin />} />
        <Route path="/member/activate" element={<ActivateHelp />} />
        <Route path="/member/activate/:token" element={<Activate />} />
        <Route path="/member/reset-pin" element={<ResetPin />} />
        <Route path="/member/*" element={<RequireMember><MemberApp /></RequireMember>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <DemoGuide />
    </Suspense>
  );
}
