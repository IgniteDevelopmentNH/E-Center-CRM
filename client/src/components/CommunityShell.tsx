import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useEscapeKey } from '../lib/hooks.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { MemberAvatar, accountTypeLabel } from './community.tsx';

/** Fired by the Messages page after reading a conversation, so the badge updates at once. */
export const UNREAD_REFRESH_EVENT = 'ecenter:unread-refresh';

/* Simple line icons for the mobile tab bar (decorative; every tab has a text label). */
const ICONS: Record<string, ReactNode> = {
  feed: <path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />,
  network: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14.6c2.6.1 4.6 1.8 5.4 4.9" />
    </>
  ),
  mentorship: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />,
  messages: <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z" />,
  posts: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1-4 4.2-6 8-6s7 2 8 6" />
    </>
  ),
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

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
  const location = useLocation();
  useEscapeKey(() => setMenuOpen(false), menuOpen);
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const canPost = !!community && community.status === 'active' && community.postPermission !== 'none';
  const nav = [
    { to: '/', label: 'Feed', icon: 'feed' },
    { to: '/network', label: 'Network', icon: 'network' },
    { to: '/mentorship', label: 'Mentorship', icon: 'mentorship' },
    { to: '/messages', label: 'Messages', icon: 'messages', badge: unread },
    ...(canPost ? [{ to: '/my-posts', label: 'Posts', icon: 'posts' }] : []),
  ];
  // Phones get a bottom tab bar; Profile fills the fifth slot when there is no Posts tab.
  const mobileNav = canPost ? nav : [...nav, { to: '/profile', label: 'Profile', icon: 'profile' }];

  const displayName = community
    ? `${community.profile.firstName} ${community.profile.lastName}`.trim()
    : (user?.name ?? '');
  const subtitle = community ? accountTypeLabel(community.accountType) : isStaff ? 'ECenter staff' : '';
  // The messages thread manages its own height on phones.
  const fullBleed = location.pathname === '/messages';

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-navy">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 bg-navy text-white shadow-raised" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 md:py-3">
          <Link to="/" className="flex shrink-0 items-center gap-3" aria-label="UNH ECenter community home">
            <img src="/unh-logo.svg" alt="University of New Hampshire" className="h-7 w-auto sm:h-9" />
            <span className="hidden h-8 w-px bg-white/25 sm:block" aria-hidden="true" />
            <span className="hidden text-lg font-bold leading-tight sm:block">ECenter Community</span>
          </Link>

          <nav className="ml-6 hidden flex-1 md:block" aria-label="Community">
            <div className="flex gap-1">
              {nav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `tab-link ${isActive ? 'border-teal-200 text-white' : ''}`}
                >
                  {item.label}
                  {!!item.badge && (
                    <span className="rounded-full bg-teal px-1.5 text-[11px] font-bold text-white" aria-label={`${item.badge} unread`}>
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </nav>

          <div className="relative ml-auto shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex min-h-[44px] items-center gap-2 rounded-lg px-1.5 text-sm font-semibold transition hover:bg-white/10"
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
                <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuOpen(false)} aria-label="Close menu" tabIndex={-1} />
                <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-700 shadow-raised" role="menu">
                  <div className="border-b border-slate-100 px-4 py-3">
                    <p className="text-sm font-semibold text-navy-800">{displayName}</p>
                    <p className="truncate text-xs text-slate-500">{user?.email}</p>
                  </div>
                  <Link to="/profile" className="flex min-h-[44px] items-center px-4 text-sm hover:bg-slate-50" role="menuitem">
                    My profile
                  </Link>
                  {canPost && (
                    <Link to="/my-posts" className="flex min-h-[44px] items-center px-4 text-sm hover:bg-slate-50" role="menuitem">
                      My posts
                    </Link>
                  )}
                  {isStaff && (
                    <Link to="/admin" className="flex min-h-[44px] items-center px-4 text-sm hover:bg-slate-50" role="menuitem">
                      Switch to admin CRM
                    </Link>
                  )}
                  <button type="button" onClick={signOut} className="flex min-h-[44px] w-full items-center px-4 text-left text-sm text-urgent hover:bg-red-50" role="menuitem">
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main
        id="main"
        className={`mx-auto w-full max-w-6xl flex-1 px-3 sm:px-4 ${fullBleed ? 'pb-20 pt-3 md:py-6' : 'pb-28 pt-4 md:py-6'}`}
      >
        {children}
      </main>

      <footer className="hidden border-t border-slate-200 bg-white px-4 py-5 md:block">
        <p className="mx-auto max-w-6xl text-center text-xs text-slate-500">
          © University of New Hampshire | ECenter | 21 Madbury Road, Durham, NH
        </p>
      </footer>

      {/* Phones: thumb-reachable tab bar. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Community"
      >
        <ul className="mx-auto flex max-w-md">
          {mobileNav.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition ${
                    isActive ? 'text-teal-700' : 'text-slate-500'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-teal" aria-hidden="true" />}
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                    {'badge' in item && !!item.badge && (
                      <span className="absolute right-[calc(50%-20px)] top-1.5 min-w-[18px] rounded-full bg-urgent px-1 text-center text-[10px] font-bold leading-[18px] text-white" aria-label={`${item.badge} unread`}>
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
