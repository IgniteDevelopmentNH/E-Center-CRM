import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { buildQuery } from '../lib/api.ts';
import { formatRelative, truncate } from '../lib/format.ts';
import { useApi, useDebounced, useEscapeKey } from '../lib/hooks.ts';
import type { SearchResponse } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { Avatar, Chip, Spinner } from './ui.tsx';

const TABS = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/contacts', label: 'Contacts', icon: '☺' },
  { to: '/notes', label: 'Notes', icon: '✎' },
  { to: '/tasks', label: 'Follow-ups', icon: '✓' },
  { to: '/organizations', label: 'Organizations', icon: '⌂' },
  { to: '/events', label: 'Events', icon: '▣' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, customer, signOut, canEdit } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 bg-navy text-white shadow-raised">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
          <Link to="/" className="flex shrink-0 items-center gap-3" aria-label="UNH ECenter CRM home">
            <img src="/unh-logo.svg" alt="University of New Hampshire" className="h-8 w-auto sm:h-9" />
            <span className="hidden h-8 w-px bg-white/25 sm:block" aria-hidden="true" />
            <span className="hidden sm:block">
              <span className="block text-sm font-bold leading-tight">ECenter CRM</span>
              <span className="block text-[11px] leading-tight text-navy-100">
                One place to nurture your entrepreneurial network
              </span>
            </span>
          </Link>

          <div className="order-3 w-full sm:order-none sm:ml-auto sm:w-auto sm:max-w-md sm:flex-1">
            <GlobalSearch />
          </div>

          <div className="relative ml-auto shrink-0 sm:ml-0">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm font-semibold transition hover:bg-white/10"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <Avatar name={user?.name ?? '?'} tone="teal" />
              <span className="hidden text-left lg:block">
                <span className="block leading-tight">{user?.name}</span>
                <span className="block text-[11px] font-normal capitalize leading-tight text-navy-100">
                  {user?.role}
                </span>
              </span>
            </button>

            {menuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => setMenuOpen(false)}
                  aria-label="Close menu"
                />
                <div
                  className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-700 shadow-raised"
                  role="menu"
                >
                  <div className="border-b border-slate-100 px-4 py-3">
                    <p className="text-sm font-semibold text-navy-800">{user?.name}</p>
                    <p className="truncate text-xs text-slate-500">{user?.email}</p>
                    {customer && <p className="mt-1 text-xs text-slate-400">{customer.name}</p>}
                  </div>
                  <Link
                    to="/settings"
                    onClick={() => setMenuOpen(false)}
                    className="block px-4 py-2.5 text-sm hover:bg-slate-50"
                    role="menuitem"
                  >
                    Settings
                  </Link>
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

        <nav className="mx-auto max-w-7xl px-4" aria-label="Main">
          <div className="scroll-x flex gap-1">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.to === '/'}
                className={({ isActive }) => `tab-link ${isActive ? 'tab-link-active' : ''}`}
              >
                <span aria-hidden="true">{tab.icon}</span>
                {tab.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>

      <footer className="border-t border-slate-200 bg-white px-4 py-5">
        <p className="mx-auto max-w-7xl text-center text-xs text-slate-500">
          © University of New Hampshire | ECenter | 21 Madbury Road, Durham, NH
        </p>
      </footer>

      {/* Quick-add, thumb-reachable on phones. */}
      {canEdit && (
        <div className="fixed bottom-5 right-5 z-40 sm:hidden">
          {fabOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 -z-10 cursor-default bg-navy-900/20"
                onClick={() => setFabOpen(false)}
                aria-label="Close quick add"
              />
              <div className="mb-3 flex flex-col items-end gap-2">
                {[
                  { label: 'New contact', to: '/contacts' },
                  { label: 'New note', to: '/notes' },
                  { label: 'New follow-up', to: '/tasks' },
                ].map((action) => (
                  <button
                    key={action.to}
                    type="button"
                    onClick={() => {
                      setFabOpen(false);
                      navigate(`${action.to}?new=1`);
                    }}
                    className="rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-navy shadow-raised"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => setFabOpen((open) => !open)}
            className="grid h-14 w-14 place-items-center rounded-full bg-teal text-3xl font-light text-white shadow-raised transition active:scale-95"
            aria-label="Quick add"
            aria-expanded={fabOpen}
          >
            {fabOpen ? '×' : '+'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Header search across contacts, organizations, notes, tasks and events. */
function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(term, 250);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const { data, loading } = useApi<SearchResponse>(
    debounced.trim().length >= 2 ? `/search${buildQuery({ q: debounced.trim() })}` : null,
  );

  useEscapeKey(() => setOpen(false), open);

  // Cmd/Ctrl+K focuses search from anywhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setTerm('');
    navigate(path);
  };

  const results = data;
  const hasResults =
    !!results &&
    results.contacts.length +
      results.organizations.length +
      results.notes.length +
      results.tasks.length +
      results.events.length >
      0;

  return (
    <div className="relative">
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-navy-100" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={inputRef}
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search people, notes, organizations..."
          aria-label="Global search"
          className="min-h-[44px] w-full rounded-lg border border-white/20 bg-white/10 pl-9 pr-3 text-sm text-white
            placeholder:text-navy-100 focus:border-white/40 focus:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/30"
        />
      </div>

      {open && debounced.trim().length >= 2 && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close search"
          />
          <div className="absolute left-0 right-0 z-20 mt-1 max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 text-slate-700 shadow-raised">
            {loading && (
              <div className="px-2 py-3">
                <Spinner label="Searching" />
              </div>
            )}

            {!loading && !hasResults && (
              <p className="px-2 py-3 text-sm text-slate-500">
                Nothing matches "{debounced.trim()}" yet.
              </p>
            )}

            {results && results.contacts.length > 0 && (
              <SearchGroup label="People">
                {results.contacts.map((contact) => (
                  <SearchRow
                    key={contact.id}
                    title={contact.fullName}
                    detail={contact.organizationName ?? contact.email}
                    meta={formatRelative(contact.lastInteractionAt)}
                    onClick={() => go(`/contacts?open=${contact.id}`)}
                  />
                ))}
              </SearchGroup>
            )}

            {results && results.organizations.length > 0 && (
              <SearchGroup label="Organizations">
                {results.organizations.map((org) => (
                  <SearchRow
                    key={org.id}
                    title={org.name}
                    detail={org.location ?? undefined}
                    meta={`${org.contactCount} ${org.contactCount === 1 ? 'person' : 'people'}`}
                    onClick={() => go(`/organizations?open=${org.id}`)}
                  />
                ))}
              </SearchGroup>
            )}

            {results && results.notes.length > 0 && (
              <SearchGroup label="Notes">
                {results.notes.map((note) => (
                  <SearchRow
                    key={note.id}
                    title={note.contactName ?? 'Note'}
                    detail={truncate(note.content, 70)}
                    meta={formatRelative(note.createdAt)}
                    onClick={() => go(`/notes?contactId=${note.contactId}`)}
                  />
                ))}
              </SearchGroup>
            )}

            {results && results.tasks.length > 0 && (
              <SearchGroup label="Follow-ups">
                {results.tasks.map((task) => (
                  <SearchRow
                    key={task.id}
                    title={task.title}
                    detail={task.contactName ?? undefined}
                    meta={<Chip tone={task.isOverdue ? 'red' : 'slate'}>{task.dueDate}</Chip>}
                    onClick={() => go('/tasks')}
                  />
                ))}
              </SearchGroup>
            )}

            {results && results.events.length > 0 && (
              <SearchGroup label="Events">
                {results.events.map((event) => (
                  <SearchRow
                    key={event.id}
                    title={event.name}
                    detail={event.location ?? undefined}
                    meta={formatRelative(event.startsAt)}
                    onClick={() => go(`/events?open=${event.id}`)}
                  />
                ))}
              </SearchGroup>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SearchGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1">
      <p className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      {children}
    </div>
  );
}

function SearchRow({
  title,
  detail,
  meta,
  onClick,
}: {
  title: string;
  detail?: string;
  meta?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition hover:bg-slate-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-navy-800">{title}</span>
        {detail && <span className="block truncate text-xs text-slate-500">{detail}</span>}
      </span>
      {meta && <span className="shrink-0 text-xs text-slate-400">{meta}</span>}
    </button>
  );
}
