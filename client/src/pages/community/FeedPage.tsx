import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MemberAvatar, accountTypeLabel } from '../../components/community.tsx';
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { formatDate, formatRelative, formatTime } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { CommunityEvent, FeedPost } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function DateBadge({ iso }: { iso: string }) {
  const date = new Date(iso);
  return (
    <span className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-navy-50 text-navy-700" aria-hidden="true">
      <span className="text-[10px] font-bold uppercase tracking-wide">{MONTHS[date.getMonth()]}</span>
      <span className="text-lg font-bold leading-none">{date.getDate()}</span>
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function PostCard({ post }: { post: FeedPost }) {
  const paragraphs = post.body.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <article className="card overflow-hidden" aria-labelledby={`post-${post.id}`}>
      <div className="p-5 sm:p-6">
        <header className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-navy text-xs font-bold text-white" aria-hidden="true">
            UNH
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-navy-800">{post.authorName}</p>
            <p className="text-xs text-slate-500">
              <time dateTime={post.publishedAt} title={`${formatDate(post.publishedAt)} at ${formatTime(post.publishedAt)}`}>
                {formatRelative(post.publishedAt)}
              </time>
              {' · UNH ECenter'}
            </p>
          </div>
        </header>
        <h2 id={`post-${post.id}`} className="mt-4 text-xl font-bold text-navy-800">
          {post.title}
        </h2>
        <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-slate-700">
          {paragraphs.map((paragraph, index) => (
            <p key={index} className="whitespace-pre-line">
              {paragraph}
            </p>
          ))}
        </div>
      </div>

      {post.imageUrl && <img src={post.imageUrl} alt="" className="max-h-[420px] w-full border-y border-slate-100 object-cover" loading="lazy" />}

      {(post.linkUrl || post.event) && (
        <div className="space-y-3 p-5 pt-4 sm:px-6">
          {post.event && (
            <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
              <DateBadge iso={post.event.startsAt} />
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Event</p>
                <p className="truncate font-semibold text-navy-800">{post.event.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {formatDate(post.event.startsAt)} · {formatTime(post.event.startsAt)}
                  {post.event.location ? ` · ${post.event.location}` : ''}
                </p>
              </div>
            </div>
          )}
          {post.linkUrl && (
            <a
              href={post.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-700 hover:underline"
            >
              {hostOf(post.linkUrl)} <span aria-hidden="true">↗</span>
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </div>
      )}
    </article>
  );
}

function ProfileSummary() {
  const { user, community, isStaff } = useAuth();
  const name = community ? `${community.profile.firstName} ${community.profile.lastName}` : (user?.name ?? '');
  const links = [
    { to: '/mentorship', label: 'Mentorship' },
    { to: '/network', label: 'Network' },
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
            <Link to="/profile" className="font-semibold text-teal-700 hover:underline">Create a community profile</Link> to message members.
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

function UpcomingEvents() {
  const { data, loading, error } = useApi<{ events: CommunityEvent[] }>('/community/events?limit=5');
  if (loading) return <div className="card p-5"><Spinner label="Loading events" /></div>;
  if (error || !data?.events.length) return null;
  return (
    <section className="card p-5" aria-labelledby="upcoming-events">
      <h2 id="upcoming-events" className="text-sm font-bold uppercase tracking-wide text-navy-800">
        Upcoming events
      </h2>
      <ul className="mt-3 space-y-4">
        {data.events.map((event) => (
          <li key={event.id} className="flex gap-3">
            <DateBadge iso={event.startsAt} />
            <div className="min-w-0">
              <p className="font-semibold leading-snug text-navy-800">{event.name}</p>
              <p className="text-xs text-slate-500">
                <time dateTime={event.startsAt}>{formatTime(event.startsAt)}</time>
                {event.location ? ` · ${event.location}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FeedPage() {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)_280px]">
      <section className="min-w-0 space-y-5 lg:order-2" aria-label="Community feed">
        <h1 className="sr-only">Community feed</h1>
        {loading && <LoadingBlock label="Loading the feed" />}
        {!loading && error && !posts.length && <ErrorBlock message={error} onRetry={initial} />}
        {!loading && !error && posts.length === 0 && (
          <EmptyState title="Nothing posted yet" message="News and announcements from the ECenter will appear here." icon="▤" />
        )}
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
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

      <aside className="lg:order-1">
        <div className="lg:sticky lg:top-28">
          <ProfileSummary />
        </div>
      </aside>

      <aside className="lg:order-3">
        <div className="lg:sticky lg:top-28">
          <UpcomingEvents />
        </div>
      </aside>
    </div>
  );
}
