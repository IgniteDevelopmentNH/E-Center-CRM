import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MemberAvatar, accountTypeLabel } from '../../components/community.tsx';
import { DateBadge, MemberPostEditor, PostCard } from '../../components/posts.tsx';
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { formatTime } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { CommunityEvent, FeedPost } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';

export function eventHref(event: CommunityEvent): string {
  return event.source === 'post' ? `/posts/${event.id}` : `/events/${event.id}`;
}

function ProfileSummary() {
  const { user, community, isStaff } = useAuth();
  const name = community ? `${community.profile.firstName} ${community.profile.lastName}` : (user?.name ?? '');
  const links = [
    { to: '/mentorship', label: 'Mentorship' },
    { to: '/network', label: 'Network' },
    ...(community && community.postPermission !== 'none' ? [{ to: '/my-posts', label: 'My posts' }] : []),
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

export function UpcomingEvents({ limit = 5, compact }: { limit?: number; compact?: boolean }) {
  const { data, loading, error, reload } = useApi<{ events: CommunityEvent[] }>(`/community/events?limit=${limit}`);
  return (
    <section className={compact ? '' : 'card p-5'} aria-labelledby="upcoming-events">
      <h2 id="upcoming-events" className="text-sm font-bold uppercase tracking-wide text-navy-800">
        Upcoming events
      </h2>
      {loading && <div className="mt-3"><Spinner label="Loading events" /></div>}
      {error && (
        <p className="mt-3 text-sm text-slate-500">
          Events could not be loaded.{' '}
          <button type="button" className="font-semibold text-teal-700 underline" onClick={reload}>Try again</button>
        </p>
      )}
      {data && data.events.length === 0 && (
        <p className="mt-3 text-sm text-slate-500">No upcoming events yet. Check back soon — new events show up here.</p>
      )}
      {data && data.events.length > 0 && (
        <ul className="mt-3 space-y-1">
          {data.events.map((event) => (
            <li key={`${event.source}-${event.id}`}>
              <Link to={eventHref(event)} className="-mx-2 flex gap-3 rounded-lg p-2 transition hover:bg-slate-50">
                <DateBadge iso={event.startsAt} />
                <span className="min-w-0">
                  <span className="block font-semibold leading-snug text-navy-800">{event.name}</span>
                  <span className="block text-xs text-slate-500">
                    <time dateTime={event.startsAt}>{formatTime(event.startsAt)}</time>
                    {event.location ? ` · ${event.location}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UpcomingEventsStrip() {
  const { data } = useApi<{ events: CommunityEvent[] }>('/community/events?limit=8');
  if (!data || data.events.length === 0) return null;
  return (
    <section className="lg:hidden" aria-labelledby="events-strip">
      <h2 id="events-strip" className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-navy-800">Upcoming events</h2>
      <ul className="no-scrollbar -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 sm:-mx-4 sm:px-4">
        {data.events.map((event) => (
          <li key={`${event.source}-${event.id}`} className="w-64 shrink-0 snap-start">
            <Link to={eventHref(event)} className="card flex h-full items-center gap-3 p-3 active:bg-slate-50">
              <DateBadge iso={event.startsAt} />
              <span className="min-w-0">
                <span className="line-clamp-2 text-sm font-semibold leading-snug text-navy-800">{event.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {formatTime(event.startsAt)}
                  {event.location ? ` · ${event.location}` : ''}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
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
        Share a post or event...
      </button>
    </div>
  );
}

export function FeedPage() {
  const { community } = useAuth();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async (after: string | null) => {
    const query = after ? `?cursor=${encodeURIComponent(after)}` : '';
    const response = await api.get<{ posts: FeedPost[]; nextCursor: string | null }>(`/community/feed${query}`);
    setPosts((current) => (after ? [...current, ...response.posts] : response.posts));
    setCursor(response.nextCursor);
  }, []);

  const initial = useCallback(() => {
    setLoading(true);
    setError(null);
    load(null)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'The feed could not be loaded.'))
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    initial();
  }, [initial]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await load(cursor);
    } catch {
      setError('More posts could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  }

  const patch = (id: string) => (change: Partial<FeedPost>) =>
    setPosts((current) => current.map((p) => (p.id === id ? { ...p, ...change } : p)));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
      <section className="min-w-0 space-y-4 sm:space-y-5 lg:order-2" aria-label="Community feed">
        <h1 className="sr-only">Community feed</h1>
        <ShareBox onCreate={() => setComposing(true)} />

        {/* On phones and tablets, events are a compact swipeable strip so the feed stays first. */}
        <UpcomingEventsStrip />

        {loading && <LoadingBlock label="Loading the feed" />}
        {!loading && error && !posts.length && <ErrorBlock message={error} onRetry={initial} />}
        {!loading && !error && posts.length === 0 && (
          <EmptyState title="Nothing posted yet" message="News, events and posts from the community will appear here." icon="▤" />
        )}
        {posts.map((post) => (
          <PostCard key={post.id} post={post} onChange={patch(post.id)} />
        ))}
        {cursor && (
          <div className="flex justify-center">
            <button type="button" className="btn-ghost" onClick={more} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load more posts'}
            </button>
          </div>
        )}
        {error && posts.length > 0 && <p className="text-center text-sm text-urgent" role="alert">{error}</p>}
      </section>

      <aside className="hidden lg:order-1 lg:block">
        <div className="lg:sticky lg:top-28">
          <ProfileSummary />
        </div>
      </aside>

      <aside className="hidden lg:order-3 lg:block">
        <div className="lg:sticky lg:top-28">
          <UpcomingEvents />
        </div>
      </aside>

      {composing && community && (
        <MemberPostEditor
          post={null}
          needsApproval={community.postPermission === 'approval'}
          onClose={() => setComposing(false)}
          onSaved={(saved) => {
            setComposing(false);
            if (saved.status === 'published') setPosts((current) => [saved, ...current]);
          }}
        />
      )}
    </div>
  );
}
