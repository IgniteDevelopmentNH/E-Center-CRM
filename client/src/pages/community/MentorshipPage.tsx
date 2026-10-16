import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MentorCard, TopicFilter } from '../../components/community.tsx';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { useApi, useDebounced } from '../../lib/hooks.ts';
import type { Recommendation } from '../../lib/types.ts';
import { usePagedMembers } from '../../lib/usePagedMembers.ts';
import { useAuth } from '../../state/AuthContext.tsx';

const PAGE_SIZE = 12;

export function MentorshipPage() {
  const { community } = useAuth();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('all');
  const debounced = useDebounced(q.trim(), 300);
  const filtering = !!debounced || tag !== 'all';

  const recs = useApi<{ recommendations: Recommendation[]; needsTags: boolean }>('/community/mentors/recommended');

  const browse = usePagedMembers('/community/mentors', { q: debounced, tag }, PAGE_SIZE);
  const { members: mentors, total, loading, error } = browse;

  const isStudent = community?.accountType === 'student';
  const recommendations = recs.data?.recommendations ?? [];

  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-gradient-to-r from-teal-50 via-navy-50 to-teal-100 px-6 py-8 sm:px-10 sm:py-10" aria-labelledby="mentorship-title">
        <h1 id="mentorship-title" className="text-3xl font-bold text-navy-800">Find your next mentor</h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          ECenter mentors are alumni, founders and professionals who volunteer their time. Browse by expertise, send a
          message, or book time when a mentor shares a scheduling link.
        </p>
      </section>

      <div className="space-y-3">
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">⌕</span>
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search by name, expertise, role or company"
            aria-label="Search mentors"
            className="input min-h-[52px] pl-10 text-base"
          />
        </div>
        <TopicFilter value={tag} onChange={setTag} />
      </div>

      {!filtering && (
        <section aria-labelledby="recommended-title">
          <h2 id="recommended-title" className="mb-3 text-lg font-bold text-navy-800">Recommended for you</h2>
          {recs.loading && <LoadingBlock label="Finding matches" />}
          {recs.error && <ErrorBlock message={recs.error} onRetry={recs.reload} />}
          {recs.data?.needsTags && (
            <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
              <p className="text-sm text-slate-600">
                Add {isStudent ? 'your interests and what you would like help with' : 'some interests'} to your profile and
                we'll recommend mentors who share them.
              </p>
              <Link to="/profile" className="btn-ghost">Add interests</Link>
            </div>
          )}
          {recs.data && !recs.data.needsTags && recommendations.length === 0 && (
            <p className="card p-5 text-sm text-slate-600">
              No mentors share your topics yet. Browse everyone below, or broaden the interests on your profile.
            </p>
          )}
          {recommendations.length > 0 && (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {recommendations.map((rec) => (
                <MentorCard key={rec.mentor.id} member={rec.mentor} reason={rec.reason} />
              ))}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="browse-title">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="browse-title" className="text-lg font-bold text-navy-800">{filtering ? 'Matching mentors' : 'All mentors'}</h2>
          {!loading && <p className="text-sm text-slate-500" aria-live="polite">{total} {total === 1 ? 'mentor' : 'mentors'}</p>}
        </div>
        {error && <ErrorBlock message={error} onRetry={browse.retry} />}
        {!error && !loading && mentors.length === 0 && (
          <EmptyState title="No mentors found" message={filtering ? 'Try a different search or topic.' : 'Mentors will appear here once they join.'} icon="★" />
        )}
        {mentors.length > 0 && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {mentors.map((mentor) => (
              <MentorCard key={mentor.id} member={mentor} />
            ))}
          </div>
        )}
        {loading && <LoadingBlock label="Loading mentors" />}
        {!loading && browse.hasMore && (
          <div className="mt-6 flex justify-center">
            <button type="button" className="btn-ghost" onClick={browse.loadMore}>
              Show more mentors
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
