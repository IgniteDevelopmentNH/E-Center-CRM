import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useEscapeKey } from '../lib/hooks.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { MemberAvatar, accountTypeLabel } from './community.tsx';

const NAV = [
  { to: '/', label: 'Feed' },
  { to: '/network', label: 'Network' },
  { to: '/mentorship', label: 'Mentorship' },
  { to: '/messages', label: 'Messages' },
];

/** Fired by the Messages page after reading a conversation, so the badge updates at once. */
export const UNREAD_REFRESH_EVENT = 'ecenter:unread-refresh';

/** Polls the unread total while the person has an active community identity. */
function useUnreadCount(enabled: boolean): number {
  const [unread, setUnread] = useState(0);
  const location = useLocation();

  useEffect(() => {
    if (!enabled) {
      setUnread(0);
      return;
    }
    let cancelled = false;
    const load = () =>
      api
        .get<{ unread: number }>('/community/messages/unread-count')
        .then((r) => !cancelled && setUnread(r.unread))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    window.addEventListener(UNREAD_REFRESH_EVENT, load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(UNREAD_REFRESH_EVENT, load);
    };
  }, [enabled, location.pathname]);

  return unread;
}

export function CommunityShell({ children }: { children: ReactNode }) {
  const { user, community, isStaff, isActiveMember, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const unread = useUnreadCount(isActiveMember);
  useEscapeKey(() => setMenuOpen(false), menuOpen);

  const displayName = community
    ? `${community.profile.firstName} ${community.profile.lastName}`.trim()
    : (user?.name ?? '');
  const subtitle = community ? accountTypeLabel(community.accountType) : isStaff ? 'ECenter staff' : '';

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-navy">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 bg-navy text-white shadow-raised">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/" className="flex shrink-0 items-center gap-3" aria-label="UNH ECenter community home">
            <img src="/unh-logo.svg" alt="University of New Hampshire" className="h-8 w-auto sm:h-9" />
            <span className="hidden h-8 w-px bg-white/25 sm:block" aria-hidden="true" />
            <span className="hidden text-lg font-bold leading-tight sm:block">ECenter Community</span>
          </Link>

          <nav className="ml-6 hidden flex-1 md:block" aria-label="Community">
            <NavLinks unread={unread} />
          </nav>

          <div className="relative ml-auto shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm font-semibold transition hover:bg-white/10"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Your profile menu"
            >
              <MemberAvatar name={displayName || '?'} photoUrl={community?.profile.photoUrl ?? null} size="sm" />
              <span className="hidden text-left lg:block">
                <span className="block leading-tight">{displayName}</span>
                {subtitle && <span className="block text-[11px] font-normal leading-tight text-navy-100">{subtitle}</span>}
              </span>
            </button>

            {menuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => setMenuOpen(false)}
                  aria-label="Close menu"
                  tabIndex={-1}
                />
                <div
                  className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-700 shadow-raised"
                  role="menu"
                >
                  <div className="border-b border-slate-100 px-4 py-3">
                    <p className="text-sm font-semibold text-navy-800">{displayName}</p>
                    <p className="truncate text-xs text-slate-500">{user?.email}</p>
                  </div>
                  <Link to="/profile" onClick={() => setMenuOpen(false)} className="block px-4 py-2.5 text-sm hover:bg-slate-50" role="menuitem">
                    My profile
                  </Link>
                  {isStaff && (
                    <Link to="/admin" onClick={() => setMenuOpen(false)} className="block px-4 py-2.5 text-sm hover:bg-slate-50" role="menuitem">
                      Switch to admin CRM
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={signOut}
                    className="block w-full px-4 py-2.5 text-left text-sm text-urgent hover:bg-red-50"
                    role="menuitem"
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Small screens: the same navigation as a scrollable row. */}
        <nav className="mx-auto max-w-6xl px-4 md:hidden" aria-label="Community (mobile)">
          <div className="scroll-x">
            <NavLinks unread={unread} />
          </div>
        </nav>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>

      <footer className="border-t border-slate-200 bg-white px-4 py-5">
        <p className="mx-auto max-w-6xl text-center text-xs text-slate-500">
          © University of New Hampshire | ECenter | 21 Madbury Road, Durham, NH
        </p>
      </footer>
    </div>
  );
}

function NavLinks({ unread }: { unread: number }) {
  return (
    <div className="flex gap-1">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) => `tab-link ${isActive ? 'border-teal-200 text-white' : ''}`}
        >
          {item.label}
          {item.to === '/messages' && unread > 0 && (
            <span className="rounded-full bg-teal px-1.5 text-[11px] font-bold text-white" aria-label={`${unread} unread`}>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </NavLink>
      ))}
    </div>
  );
}
