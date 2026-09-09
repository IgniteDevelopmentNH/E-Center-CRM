import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '../lib/api.ts';
import type { SessionUser } from '../lib/types.ts';

interface AuthState {
  user: SessionUser | null;
  customer: { name: string; slug: string } | null;
  ready: boolean;
  signIn: (email: string, password: string, remember: boolean) => Promise<void>;
  signOut: () => void;
  /** Owners manage the team; viewers are read-only. */
  canEdit: boolean;
  isOwner: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [customer, setCustomer] = useState<{ name: string; slug: string } | null>(null);
  const [ready, setReady] = useState(false);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setCustomer(null);
  }, []);

  // An expired token anywhere in the app drops straight back to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setCustomer(null);
    });
  }, []);

  // Restore an existing session on load.
  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    api
      .get<{ user: SessionUser; customer: { name: string; slug: string } }>('/auth/me')
      .then((response) => {
        setUser(response.user);
        setCustomer(response.customer);
      })
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const signIn = useCallback(async (email: string, password: string, remember: boolean) => {
    const response = await api.post<{ token: string; user: SessionUser }>('/auth/login', {
      email,
      password,
      remember,
    });
    setToken(response.token, remember);
    setUser(response.user);
    const me = await api.get<{ customer: { name: string; slug: string } }>('/auth/me');
    setCustomer(me.customer);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      customer,
      ready,
      signIn,
      signOut,
      canEdit: user ? user.role !== 'viewer' : false,
      isOwner: user?.role === 'owner',
    }),
    [user, customer, ready, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
