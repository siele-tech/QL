import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api';
import { clearDataCache, FullPageSpinner } from './components/ui';

export interface Me {
  authenticated: boolean;
  principal?: { type: 'MEMBER'; id: string; name: string; role: string; roleName: string; permissions: string[] };
  organization?: { id: string; name: string; type: string; code: string };
  home?: string;
  demoMode?: boolean;
}

const Ctx = createContext<{ me: Me | null; refresh: () => Promise<Me>; logout: () => Promise<void> }>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    const m = await api.get<Me>('/auth/me').catch(() => ({ authenticated: false }) as Me);
    clearDataCache(); // never show one person's cached screens to the next person on this device
    setMe(m);
    return m;
  }, []);
  const logout = useCallback(async () => { await api.post('/auth/logout').catch(() => {}); clearDataCache(); setMe({ authenticated: false }); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return <Ctx.Provider value={{ me, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** Route guard: only signed-in members reach /member. */
export function RequireMember({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const loc = useLocation();
  if (!me) return <FullPageSpinner />;
  if (!me.authenticated || me.principal!.type !== 'MEMBER') return <Navigate to="/member/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}
