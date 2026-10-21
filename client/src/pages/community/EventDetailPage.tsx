import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DateBadge, RsvpButton, eventWhen } from '../../components/posts.tsx';
import { ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { useApi } from '../../lib/hooks.ts';
import type { CommunityEventDetail } from '../../lib/types.ts';

/** An ECenter event shown to the community (public details only). */
export function EventDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<{ event: CommunityEventDetail }>(id ? `/community/events/${id}` : null);
  const [event, setEvent] = useState<CommunityEventDetail | null>(null);

  useEffect(() => {
    if (data) setEvent(data.event);
  }, [data]);

  if (loading && !event) return <LoadingBlock label="Loading event" />;
  if (error || !event) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <ErrorBlock message={error ?? 'That event is not available.'} onRetry={reload} />
        <Link to="/" className="btn-ghost">Back to the feed</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link to="/" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-teal-700 hover:underline">
        <span aria-hidden="true">←</span>&nbsp;Feed
      </Link>
      <article className="card overflow-hidden" aria-labelledby="event-title">
        <div className="h-2 bg-teal" aria-hidden="true" />
        <div className="space-y-5 p-4 sm:p-6">
          <div className="flex items-start gap-4">
            <DateBadge iso={event.startsAt} size="lg" />
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wide text-teal-700">UNH ECenter event</p>
              <h1 id="event-title" className="text-2xl font-bold text-navy-800">{event.name}</h1>
              <p className="mt-1 text-slate-700">{eventWhen(event.startsAt, event.endsAt)}</p>
              {event.location && <p className="text-sm text-slate-600">{event.location}</p>}
            </div>
          </div>
          {event.details && <p className="whitespace-pre-line text-[15px] leading-relaxed text-slate-700">{event.details}</p>}
          {event.rsvpEnabled && (
            <div className="border-t border-slate-100 pt-4">
              <RsvpButton
                target="event"
                id={event.id}
                going={event.going}
                count={event.rsvpCount}
                onChange={(state) => setEvent({ ...event, going: state.going, rsvpCount: state.rsvpCount })}
              />
            </div>
          )}
        </div>
      </article>
    </div>
  );
}
