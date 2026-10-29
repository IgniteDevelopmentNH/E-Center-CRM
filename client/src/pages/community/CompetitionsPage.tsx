import { Link, useParams } from 'react-router-dom';
import { DateBadge } from '../../components/posts.tsx';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { formatDate, formatTime } from '../../lib/format.ts';
import { useApi, useCommunityBase } from '../../lib/hooks.ts';
import type { Competition } from '../../lib/types.ts';

function DeadlineLine({ competition }: { competition: Competition }) {
  if (!competition.nextDeadline) {
    return <p className="text-sm font-semibold text-slate-500">All deadlines have passed</p>;
  }
  return (
    <p className="text-sm text-slate-700">
      <span className="font-semibold text-amber-800">{competition.nextDeadline.label}:</span>{' '}
      <time dateTime={competition.nextDeadline.dueAt}>
        {formatDate(competition.nextDeadline.dueAt)} at {formatTime(competition.nextDeadline.dueAt)}
      </time>
    </p>
  );
}

export function CompetitionsPage() {
  const base = useCommunityBase();
  const { data, loading, error, reload } = useApi<{ competitions: Competition[] }>(`${base}/competitions`);
  const open = data?.competitions.filter((c) => c.nextDeadline) ?? [];
  const past = data?.competitions.filter((c) => !c.nextDeadline) ?? [];

  const card = (competition: Competition) => (
    <li key={competition.id} className="card overflow-hidden">
      <Link to={`/competitions/${competition.id}`} className="flex flex-col sm:flex-row">
        {competition.imageUrl && (
          <img src={competition.imageUrl} alt="" className="h-40 w-full object-cover sm:h-auto sm:w-48" loading="lazy" />
        )}
        <div className="flex min-w-0 flex-1 gap-4 p-4 sm:p-5">
          {competition.nextDeadline && <DateBadge iso={competition.nextDeadline.dueAt} />}
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-bold text-navy-800 hover:underline">{competition.title}</h3>
            {competition.summary && <p className="text-sm text-slate-600">{competition.summary}</p>}
            {competition.prize && <p className="text-sm font-semibold text-teal-800">Prize: {competition.prize}</p>}
            <DeadlineLine competition={competition} />
          </div>
        </div>
      </Link>
    </li>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-navy-800">Competitions</h1>
        <p className="mt-1 text-sm text-slate-500">
          ECenter pitch and venture competitions. Deadlines also appear in Upcoming events.
        </p>
      </div>
      {loading && !data && <LoadingBlock label="Loading competitions" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.competitions.length === 0 && (
        <EmptyState title="No competitions right now" message="Upcoming ECenter competitions will be posted here." icon="★" />
      )}
      {open.length > 0 && (
        <section aria-labelledby="open-competitions" className="space-y-3">
          <h2 id="open-competitions" className="text-sm font-bold uppercase tracking-wide text-navy-800">Open</h2>
          <ul className="space-y-4">{open.map(card)}</ul>
        </section>
      )}
      {past.length > 0 && (
        <section aria-labelledby="past-competitions" className="space-y-3">
          <h2 id="past-competitions" className="text-sm font-bold uppercase tracking-wide text-slate-500">Past</h2>
          <ul className="space-y-4 opacity-80">{past.map(card)}</ul>
        </section>
      )}
    </div>
  );
}

export function CompetitionDetailPage() {
  const { id } = useParams();
  const base = useCommunityBase();
  const { data, loading, error, reload } = useApi<{ competition: Competition }>(id ? `${base}/competitions/${id}` : null);

  if (loading && !data) return <LoadingBlock label="Loading competition" />;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <ErrorBlock message={error ?? 'That competition is not available.'} onRetry={reload} />
        <Link to="/competitions" className="btn-ghost">All competitions</Link>
      </div>
    );
  }
  const { competition } = data;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link to="/competitions" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-teal-700 hover:underline">
        <span aria-hidden="true">←</span>&nbsp;Competitions
      </Link>
      <article className="card overflow-hidden" aria-labelledby="competition-title">
        {competition.imageUrl ? (
          <img src={competition.imageUrl} alt="" className="max-h-72 w-full object-cover" />
        ) : (
          <div className="h-2 bg-amber-400" aria-hidden="true" />
        )}
        <div className="space-y-5 p-4 sm:p-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-amber-700">ECenter competition</p>
            <h1 id="competition-title" className="text-2xl font-bold text-navy-800">{competition.title}</h1>
            {competition.summary && <p className="mt-1 text-slate-600">{competition.summary}</p>}
          </div>

          {(competition.prize || competition.eligibility) && (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {competition.prize && (
                <div className="rounded-lg bg-teal-50 p-3">
                  <dt className="text-xs font-bold uppercase tracking-wide text-teal-800">Prize</dt>
                  <dd className="mt-0.5 text-sm text-teal-900">{competition.prize}</dd>
                </div>
              )}
              {competition.eligibility && (
                <div className="rounded-lg bg-slate-50 p-3">
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-600">Who can enter</dt>
                  <dd className="mt-0.5 whitespace-pre-line text-sm text-slate-700">{competition.eligibility}</dd>
                </div>
              )}
            </dl>
          )}

          {competition.deadlines.length > 0 && (
            <section aria-labelledby="deadlines">
              <h2 id="deadlines" className="text-sm font-bold uppercase tracking-wide text-navy-800">Deadlines</h2>
              <ul className="mt-2 space-y-2">
                {competition.deadlines.map((deadline) => (
                  <li key={deadline.id} className={`flex items-center gap-3 ${deadline.passed ? 'opacity-60' : ''}`}>
                    <DateBadge iso={deadline.dueAt} />
                    <span>
                      <span className="block font-semibold text-navy-800">
                        {deadline.label}
                        {deadline.passed && <span className="ml-2 text-xs font-normal text-slate-500">(passed)</span>}
                      </span>
                      <span className="block text-sm text-slate-600">
                        {formatDate(deadline.dueAt)} at {formatTime(deadline.dueAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {competition.description && (
            <p className="whitespace-pre-line text-[15px] leading-relaxed text-slate-700">{competition.description}</p>
          )}

          {competition.linkUrl && (
            <a href={competition.linkUrl} target="_blank" rel="noopener noreferrer" className="btn-primary">
              Apply / learn more <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
      </article>
    </div>
  );
}
