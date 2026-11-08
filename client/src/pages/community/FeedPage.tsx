import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MemberAvatar, accountTypeLabel } from '../../components/community.tsx';
import { CrmEventCard, DateBadge, DeadlineCard, MemberPostEditor, PostCard } from '../../components/posts.tsx';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { ApiError, api, buildQuery } from '../../lib/api.ts';
import { useApi, useCommunityBase } from '../../lib/hooks.ts';
import type { Competition, FeedItem } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';

function GuestSummary() {
  return (
    <section className="card overflow-hidden" aria-label="Join the community">
      <div className="h-14 bg-gradient-to-r from-navy to-teal-700" aria-hidden="true" />
      <div className="space-y-3 p-5">
        <p className="font-bold text-navy-800">Welcome to the ECenter community</p>
        <p className="text-sm text-slate-600">
          You're browsing as a guest. Create an account to comment, RSVP, join groups, list your business and meet mentors.
        </p>
        <Link to="/signup" className="btn-primary w-full">Create an account</Link>
        <Link to="/login" className="btn-ghost w-full">Sign in</Link>
      </div>
    </section>
  );
}

function ProfileSummary() {
  const { user, community, isStaff } = useAuth();
  if (!user) return <GuestSummary />;
  const name = community ? `${community.profile.firstName} ${community.profile.lastName}` : (user?.name ?? '');
  const links = [
    { to: '/mentorship', label: 'Mentorship' },
    { to: '/network', label: 'Network' },
    { to: '/groups', label: 'Groups' },
    { to: '/businesses', label: 'Businesses' },
    { to: '/competitions', label: 'Competitions' },
    ...(community && community.postPermission !== 'none' ? [{ to: '/my-posts', label: 'My events' }] : []),
    { to: '/profile', label: 'My profile' },
  ];
  return (
    <section className="card overflow-hidden" aria-label="Your profile">
      <div className="h-14 bg-gradient-to-r from-navy to-teal-700" aria-hidden="true" />
      <div className="-mt-8 px-5 pb-5">
        <MemberAvatar name={name} photoUrl={community?.profile.photoUrl ?? null} size="lg" />
        <p className="mt-2 font-bold text-navy-800">{name}</p>
        <p className="text-sm text-slate-500">
          {community ? accountTypeLabel(community.accountType) : isStaff ? 'ECenter staff' : ''}
        </p>
        {!community && isStaff && (
          <p className="mt-2 text-xs text-slate-500">
            You're browsing as staff.{' '}
            <Link to="/profile" className="font-semibold text-teal-700 hover:underline">Create a community profile</Link> to message,
            comment and like.
          </p>
        )}
      </div>
      <nav className="border-t border-slate-100 py-1" aria-label="Quick links">
        {links.map((link) => (
          <Link key={link.to} to={link.to} className="flex min-h-[44px] items-center px-5 text-sm font-semibold text-navy-700 hover:bg-slate-50">
            {link.label}
          </Link>
        ))}
      </nav>
    </section>
  );
}

/** Open competitions and their next deadlines, beside the feed. */
function OpenCompetitions() {
  const base = useCommunityBase();
  const { data } = useApi<{ competitions: Competition[] }>(`${base}/competitions?limit=4`);
  const open = data?.competitions.filter((c) => c.nextDeadline) ?? [];
  return (
    <section className="card p-5" aria-labelledby="open-competitions-heading">
      <h2 id="open-competitions-heading" className="text-sm font-bold uppercase tracking-wide text-navy-800">
        Competitions
      </h2>
      {data && open.length === 0 && <p className="mt-3 text-sm text-slate-500">No open competitions right now.</p>}
      {open.length > 0 && (
        <ul className="mt-3 space-y-1">
          {open.map((competition) => (
            <li key={competition.id}>
              <Link to={`/competitions/${competition.id}`} className="-mx-2 flex gap-3 rounded-lg p-2 transition hover:bg-slate-50">
                <DateBadge iso={competition.nextDeadline!.dueAt} />
                <span className="min-w-0">
                  <span className="block font-semibold leading-snug text-navy-800">{competition.title}</span>
                  <span className="block text-xs text-slate-500">{competition.nextDeadline!.label}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/competitions" className="mt-2 inline-block text-sm font-semibold text-teal-700 hover:underline">All competitions</Link>
    </section>
  );
}

function ShareBox({ onCreate }: { onCreate: () => void }) {
  const { community } = useAuth();
  if (!community || community.postPermission === 'none') return null;
  const name = `${community.profile.firstName} ${community.profile.lastName}`;
  return (
    <div className="card flex items-center gap-3 p-3 sm:p-4">
      <MemberAvatar name={name} photoUrl={community.profile.photoUrl} size="sm" />
      <button
        type="button"
        onClick={onCreate}
        className="min-h-[44px] flex-1 rounded-full border border-slate-300 px-4 text-left text-sm text-slate-500 transition hover:border-teal-200 hover:bg-slate-50"
      >
        Add an event...
      </button>
    </div>
  );
}

const itemKey = (item: FeedItem) =>
  item.kind === 'post' ? `post-${item.post.id}` : item.kind === 'event' ? `event-${item.event.id}` : `deadline-${item.deadline.id}`;

export function FeedPage() {
  const { community } = useAuth();
  const base = useCommunityBase();
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const id = ++requestId.current;
      const response = await api.get<{ items: FeedItem[]; nextCursor: string | null }>(
        `${base}/feed${buildQuery({ when: when === 'past' ? 'past' : undefined, cursor: after })}`,
      );
      if (id !== requestId.current) return;
      setItems((current) => (after ? [...current, ...response.items] : response.items));
      setCursor(response.nextCursor);
    },
    [base, when],
  );

  const initial = useCallback(() => {
    setLoading(true);
    setError(null);
    load(null)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'The feed could not be loaded.'))
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(initial, [initial]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await load(cursor);
    } catch {
      setError('More events could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  }

  const replace = (key: string, next: (item: FeedItem) => FeedItem) =>
    setItems((current) => current.map((item) => (itemKey(item) === key ? next(item) : item)));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
      <section className="min-w-0 space-y-4 sm:space-y-5 lg:order-2" aria-label="Community events">
        <h1 className="sr-only">Community events</h1>
        <ShareBox onCreate={() => setComposing(true)} />

        <div className="flex gap-1 rounded-lg bg-slate-100 p-1" role="group" aria-label="Which events">
          {(['upcoming', 'past'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={when === value}
              onClick={() => setWhen(value)}
              className={`min-h-[40px] flex-1 rounded-md text-sm font-semibold ${when === value ? 'bg-white text-navy-800 shadow-card' : 'text-slate-600'}`}
            >
              {value === 'upcoming' ? 'Upcoming events' : 'Past events'}
            </button>
          ))}
        </div>

        {loading && <LoadingBlock label="Loading events" />}
        {!loading && error && !items.length && <ErrorBlock message={error} onRetry={initial} />}
        {!loading && !error && items.length === 0 && (
          <EmptyState
            title={when === 'upcoming' ? 'No upcoming events yet' : 'No past events'}
            message={when === 'upcoming' ? 'Events and competition deadlines will appear here.' : 'Events that have happened will appear here.'}
            icon="▤"
          />
        )}
        {!loading &&
          items.map((item) => {
            const key = itemKey(item);
            if (item.kind === 'post') {
              return (
                <PostCard
                  key={key}
                  post={item.post}
                  onChange={(change) => replace(key, (old) => (old.kind === 'post' ? { ...old, post: { ...old.post, ...change } } : old))}
                />
              );
            }
            if (item.kind === 'event') {
              return (
                <CrmEventCard
                  key={key}
                  event={item.event}
                  onChange={(change) => replace(key, (old) => (old.kind === 'event' ? { ...old, event: { ...old.event, ...change } } : old))}
                />
              );
            }
            return <DeadlineCard key={key} deadline={item.deadline} />;
          })}
        {cursor && !loading && (
          <div className="flex justify-center">
            <button type="button" className="btn-ghost" onClick={more} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load more events'}
            </button>
          </div>
        )}
        {error && items.length > 0 && <p className="text-center text-sm text-urgent" role="alert">{error}</p>}
      </section>

      <aside className="hidden lg:order-1 lg:block">
        <div className="lg:sticky lg:top-28">
          <ProfileSummary />
        </div>
      </aside>

      <aside className="hidden lg:order-3 lg:block">
        <div className="lg:sticky lg:top-28">
          <OpenCompetitions />
        </div>
      </aside>

      {composing && community && (
        <MemberPostEditor
          post={null}
          needsApproval={community.postPermission === 'approval'}
          onClose={() => setComposing(false)}
          onSaved={(saved) => {
            setComposing(false);
            if (saved.status === 'published') initial();
          }}
        />
      )}
    </div>
  );
}
