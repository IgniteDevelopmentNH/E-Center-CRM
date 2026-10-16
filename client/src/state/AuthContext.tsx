import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '../lib/api.ts';
import type { CommunityState, SessionUser } from '../lib/types.ts';

interface MeResponse {
  user: SessionUser;
  customer: { name: string; slug: string };
  community: CommunityState | null;
}

interface AuthState {
  user: SessionUser | null;
  customer: { name: string; slug: string } | null;
  /** The signed-in person's own community account, if they have one. */
  community: CommunityState | null;
  ready: boolean;
  signIn: (email: string, password: string, remember: boolean) => Promise<SessionUser>;
  signOut: () => void;
  /** Adopts a session issued by signup. */
  startSession: (token: string) => Promise<void>;
  /** Re-reads /auth/me (after verifying email, finishing onboarding, editing a profile...). */
  refresh: () => Promise<void>;
  setCommunity: (community: CommunityState | null) => void;
  /** Staff = owner/editor/viewer. Only a UI hint: the server enforces every permission. */
  isStaff: boolean;
  /** Owners manage the team; viewers are read-only. */
  canEdit: boolean;
  isOwner: boolean;
  /** Has an ACTIVE community identity (required to message members). */
  isActiveMember: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [customer, setCustomer] = useState<{ name: string; slug: string } | null>(null);
  const [community, setCommunity] = useState<CommunityState | null>(null);
  const [ready, setReady] = useState(false);

  const clear = useCallback(() => {
    setUser(null);
    setCustomer(null);
    setCommunity(null);
  }, []);

  const signOut = useCallback(() => {
    // Best effort: revoke the session server-side too.
    if (getToken()) void api.post('/auth/logout').catch(() => undefined);
    setToken(null);
    clear();
  }, [clear]);

  // An expired or revoked token anywhere in the app drops straight back to signed-out.
  useEffect(() => {
    setUnauthorizedHandler(clear);
  }, [clear]);

  const loadMe = useCallback(async () => {
    const me = await api.get<MeResponse>('/auth/me');
    setUser(me.user);
    setCustomer(me.customer);
    setCommunity(me.community);
  }, []);

  // Restore an existing session on load.
  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    loadMe()
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, [loadMe]);

  const signIn = useCallback(
    async (email: string, password: string, remember: boolean) => {
      const response = await api.post<{ token: string; user: SessionUser }>('/auth/login', {
        email,
        password,
        remember,
      });
      setToken(response.token, remember);
      await loadMe();
      return response.user;
    },
    [loadMe],
  );

  const startSession = useCallback(
    async (token: string) => {
      setToken(token, true);
      await loadMe();
    },
    [loadMe],
  );

  const refresh = useCallback(async () => {
    if (getToken()) await loadMe();
  }, [loadMe]);

  const value = useMemo<AuthState>(() => {
    const isStaff = !!user?.isStaff;
    return {
      user,
      customer,
      community,
      ready,
      signIn,
      signOut,
      startSession,
      refresh,
      setCommunity,
      isStaff,
      canEdit: isStaff && user?.role !== 'viewer',
      isOwner: user?.role === 'owner',
      isActiveMember: community?.status === 'active',
    };
  }, [user, customer, community, ready, signIn, signOut, startSession, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
