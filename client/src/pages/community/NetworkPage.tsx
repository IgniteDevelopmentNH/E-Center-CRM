import { useState } from 'react';
import { MemberActions, MemberCard, TopicFilter } from '../../components/community.tsx';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { useDebounced } from '../../lib/hooks.ts';
import { usePagedMembers } from '../../lib/usePagedMembers.ts';

const TYPES = [
  { value: 'all', label: 'Everyone' },
  { value: 'student', label: 'Students' },
  { value: 'mentor', label: 'Mentors' },
  { value: 'staff', label: 'ECenter staff' },
];

export function NetworkPage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [tag, setTag] = useState('all');
  const debounced = useDebounced(q.trim(), 300);
  const { members, total, loading, error, loadMore, retry, hasMore } = usePagedMembers(
    '/community/members',
    { q: debounced, type, tag },
    24,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-navy-800">Network</h1>
        <p className="mt-1 text-sm text-slate-500">Students, mentors and ECenter staff in the community.</p>
      </div>

      <div className="card space-y-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">⌕</span>
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search by name, interest, role, company or major"
              aria-label="Search members"
              className="input pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1" role="group" aria-label="Member type">
            {TYPES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setType(option.value)}
                aria-pressed={type === option.value}
                className={`min-h-[36px] flex-1 whitespace-nowrap rounded-md px-3 text-sm font-semibold transition ${
                  type === option.value ? 'bg-white text-navy-800 shadow-card' : 'text-slate-600 hover:text-navy-800'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <TopicFilter value={tag} onChange={setTag} />
      </div>

      <p className="text-sm text-slate-500" aria-live="polite">
        {loading && !members.length ? 'Loading members...' : `${total} ${total === 1 ? 'member' : 'members'}`}
      </p>

      {error && <ErrorBlock message={error} onRetry={retry} />}
      {!error && !loading && members.length === 0 && (
        <EmptyState title="No one matches that yet" message="Try a broader search or a different topic." icon="☺" />
      )}

      {members.length > 0 && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {members.map((member) => (
            <MemberCard key={member.id} member={member} footer={<MemberActions member={member} compact />} />
          ))}
        </div>
      )}
      {loading && members.length > 0 && <LoadingBlock label="Loading more" />}
      {!loading && hasMore && (
        <div className="flex justify-center">
          <button type="button" className="btn-ghost" onClick={loadMore}>
            Show more
          </button>
        </div>
      )}
    </div>
  );
}
