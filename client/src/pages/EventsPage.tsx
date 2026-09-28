import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EventForm } from '../components/forms.tsx';
import { ConfirmDialog, Modal, SlideOver } from '../components/overlays.tsx';
import { useEscapeKey } from '../lib/hooks.ts';
import {
  Avatar,
  Chip,
  EVENT_TYPE_TONES,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  SectionHeader,
  Select,
  StatusChip,
} from '../components/ui.tsx';
import { ApiError, api, buildQuery } from '../lib/api.ts';
import { EVENT_TYPES } from '../lib/constants.ts';
import { formatDate, formatDateTime, formatTime } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import type { Contact, CrmEvent } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function EventsPage() {
  const { canEdit } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [view, setView] = useState<'month' | 'list'>('month');
  const [eventType, setEventType] = useState('all');
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [creating, setCreating] = useState(false);

  const openId = searchParams.get('open');

  // The month view fetches its visible range; the list view shows what is ahead.
  const range = useMemo(() => {
    if (view === 'list') return { from: '', to: '', upcoming: true };
    const start = new Date(cursor.year, cursor.month, 1);
    const end = new Date(cursor.year, cursor.month + 1, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      from: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`,
      to: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
      upcoming: false,
    };
  }, [view, cursor]);

  const query = useMemo(
    () =>
      buildQuery({
        from: range.from,
        to: range.to,
        upcoming: range.upcoming ? 'true' : '',
        eventType,
      }),
    [range, eventType],
  );

  const { data, loading, error, reload } = useApi<{ events: CrmEvent[] }>(`/events${query}`);
  const events = data?.events ?? [];

  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('open', id);
    else next.delete('open');
    setSearchParams(next, { replace: true });
  };

  const byDay = useMemo(() => {
    const map = new Map<number, CrmEvent[]>();
    for (const event of events) {
      const date = new Date(event.startsAt);
      if (date.getFullYear() !== cursor.year || date.getMonth() !== cursor.month) continue;
      const day = date.getDate();
      map.set(day, [...(map.get(day) ?? []), event]);
    }
    return map;
  }, [events, cursor]);

  const monthCells = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const leading = first.getDay();
    const cells: (number | null)[] = Array.from({ length: leading }, () => null);
    for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [cursor]);

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === cursor.year && today.getMonth() === cursor.month;

  function shiftMonth(delta: number) {
    setCursor((current) => {
      const date = new Date(current.year, current.month + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });
  }

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Events</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Linking someone to an event logs the attendance on their timeline automatically.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            + Add event
          </button>
        )}
      </header>

      <div className="card mb-5 flex flex-wrap items-center gap-3 p-4">
        <div className="flex rounded-lg border border-slate-300 p-0.5" role="tablist">
          {(['month', 'list'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              onClick={() => setView(option)}
              className={`min-h-[36px] rounded-md px-3 text-sm font-semibold capitalize transition ${
                view === option ? 'bg-navy text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {option === 'month' ? 'Month' : 'Upcoming'}
            </button>
          ))}
        </div>

        {view === 'month' && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn-ghost min-h-[36px] px-3"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
            >
              ‹
            </button>
            <MonthYearPicker
              year={cursor.year}
              month={cursor.month}
              onChange={(year, month) => setCursor({ year, month })}
            />
            <button
              type="button"
              className="btn-ghost min-h-[36px] px-3"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
            >
              ›
            </button>
            {!isCurrentMonth && (
              <button
                type="button"
                className="btn-quiet"
                onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}
              >
                Today
              </button>
            )}
          </div>
        )}

        <div className="ml-auto w-44">
          <Select
            value={eventType}
            options={EVENT_TYPES}
            includeAll
            allLabel="All types"
            onChange={(event) => setEventType(event.target.value)}
            aria-label="Filter by event type"
          />
        </div>
      </div>

      {loading && !data && <LoadingBlock label="Loading events" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {view === 'month' && data && (
        <div className="card overflow-hidden">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {WEEKDAYS.map((day) => (
              <div
                key={day}
                className="px-2 py-2 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500"
              >
                <span className="sm:hidden">{day[0]}</span>
                <span className="hidden sm:inline">{day}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {monthCells.map((day, index) => {
              const dayEvents = day ? (byDay.get(day) ?? []) : [];
              const isToday = isCurrentMonth && day === today.getDate();
              return (
                <div
                  key={day ?? `empty-${index}`}
                  className={`min-h-[84px] border-b border-r border-slate-100 p-1.5 sm:min-h-[110px] ${
                    day ? '' : 'bg-slate-50/60'
                  }`}
                >
                  {day && (
                    <>
                      <span
                        className={`mb-1 inline-grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${
                          isToday ? 'bg-navy text-white' : 'text-slate-500'
                        }`}
                      >
                        {day}
                      </span>
                      <div className="space-y-1">
                        {dayEvents.map((event) => (
                          <button
                            key={event.id}
                            type="button"
                            onClick={() => setOpenId(event.id)}
                            className="block w-full truncate rounded bg-teal-50 px-1.5 py-1 text-left text-[11px] font-semibold text-teal-800 transition hover:bg-teal-100"
                            title={`${event.name} -- ${formatTime(event.startsAt)}`}
                          >
                            {formatTime(event.startsAt)} {event.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'list' && data && (
        <>
          {events.length === 0 ? (
            <EmptyState
              icon="▣"
              title="Nothing on the calendar yet"
              message="Add an event and link the people who attend."
              action={
                canEdit ? (
                  <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                    + Add event
                  </button>
                ) : undefined
              }
            />
          ) : (
            <ul className="space-y-3">
              {events.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(event.id)}
                    className="card-interactive flex w-full items-start gap-4 p-4 text-left"
                  >
                    <div className="w-14 shrink-0 rounded-lg bg-navy-50 py-1.5 text-center">
                      <p className="text-[10px] font-bold uppercase text-navy-600">
                        {MONTH_NAMES[new Date(event.startsAt).getMonth()]?.slice(0, 3)}
                      </p>
                      <p className="text-xl font-bold leading-none text-navy">
                        {new Date(event.startsAt).getDate()}
                      </p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-navy-800">{event.name}</h3>
                      <p className="text-sm text-slate-500">
                        {formatTime(event.startsAt)}
                        {event.endsAt && ` - ${formatTime(event.endsAt)}`}
                        {event.location && ` · ${event.location}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <StatusChip value={event.eventType} tones={EVENT_TYPE_TONES} />
                        <Chip tone="slate">
                          {event.attendeeCount} {event.attendeeCount === 1 ? 'attendee' : 'attendees'}
                        </Chip>
                        {event.externalId && <Chip tone="teal">Outlook</Chip>}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Modal open={creating} title="Add an event" onClose={() => setCreating(false)} width="max-w-2xl">
        <EventForm
          onCancel={() => setCreating(false)}
          onSaved={(event) => {
            setCreating(false);
            reload();
            setOpenId(event.id);
          }}
        />
      </Modal>

      {openId && <EventPanel eventId={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}

/** The calendar's month/year label, clickable to jump to any month and year. */
function MonthYearPicker({
  year,
  month,
  onChange,
}: {
  year: number;
  month: number;
  onChange: (year: number, month: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const yearListRef = useRef<HTMLDivElement>(null);
  const currentYear = new Date().getFullYear();
  // A generous, scrollable range on either side of both the current and the viewed year.
  const minYear = Math.min(year, currentYear) - 12;
  const maxYear = Math.max(year, currentYear) + 12;
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);

  useEscapeKey(() => setOpen(false), open);

  // Bring the selected year into view each time the panel opens.
  useEffect(() => {
    if (!open) return;
    const node = yearListRef.current?.querySelector('[data-selected="true"]');
    node?.scrollIntoView({ block: 'center' });
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="min-h-[36px] min-w-[9.5rem] rounded-md px-2 text-center text-sm font-bold text-navy-800 transition hover:bg-slate-100"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {MONTH_NAMES[month]} {year}
        <span className="ml-1 text-xs text-slate-400" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close month picker"
          />
          <div className="absolute left-1/2 z-30 mt-1 flex w-64 -translate-x-1/2 gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-raised">
            <div className="max-h-64 flex-1 overflow-y-auto pr-1">
              {MONTH_NAMES.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    onChange(year, index);
                    setOpen(false);
                  }}
                  className={`block w-full rounded-md px-3 py-1.5 text-left text-sm transition ${
                    index === month
                      ? 'bg-navy font-semibold text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
            <div ref={yearListRef} className="max-h-64 w-20 overflow-y-auto border-l border-slate-100 pl-2">
              {years.map((value) => (
                <button
                  key={value}
                  type="button"
                  data-selected={value === year}
                  onClick={() => {
                    onChange(value, month);
                    setOpen(false);
                  }}
                  className={`block w-full rounded-md px-2 py-1.5 text-center text-sm transition ${
                    value === year
                      ? 'bg-navy font-semibold text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EventPanel({
  eventId,
  onClose,
  onChanged,
}: {
  eventId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { canEdit } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ event: CrmEvent; attendees: Contact[] }>(
    `/events/${eventId}`,
  );

  const [editing, setEditing] = useState(false);
  const [addId, setAddId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: allContacts } = useApi<{ contacts: Contact[] }>('/contacts?limit=200&sort=name');

  const event = data?.event;
  const attendeeIds = new Set((data?.attendees ?? []).map((contact) => contact.id));
  const candidates = (allContacts?.contacts ?? []).filter((contact) => !attendeeIds.has(contact.id));

  async function addAttendee() {
    if (!addId) return;
    setBusy(true);
    try {
      await api.post(`/events/${eventId}/attendees`, { contactId: addId });
      toast.success('Attendance recorded on their timeline.');
      setAddId('');
      reload();
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That person could not be added.');
    } finally {
      setBusy(false);
    }
  }

  async function removeAttendee(contact: Contact) {
    try {
      await api.delete(`/events/${eventId}/attendees/${contact.id}`);
      toast.success(`${contact.fullName} removed. The attendance note was kept.`);
      reload();
      onChanged();
    } catch {
      toast.error('That person could not be removed.');
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.delete(`/events/${eventId}`);
      toast.success('Event deleted.');
      onChanged();
      onClose();
    } catch {
      toast.error('That event could not be deleted.');
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <SlideOver
      open
      title={event?.name ?? 'Event'}
      subtitle={event ? formatDateTime(event.startsAt) : undefined}
      onClose={onClose}
      footer={
        canEdit && event ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              Edit event
            </button>
            <button
              type="button"
              className="btn-quiet ml-auto text-urgent hover:bg-red-50"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          </div>
        ) : undefined
      }
    >
      {loading && !event && <LoadingBlock label="Loading event" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {event && (
        <div className="space-y-6">
          <section>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusChip value={event.eventType} tones={EVENT_TYPE_TONES} />
              {event.externalId && <Chip tone="teal">Synced with Outlook</Chip>}
            </div>
            <dl className="mt-3 grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">When</dt>
                <dd className="text-slate-600">
                  {formatDate(event.startsAt)}, {formatTime(event.startsAt)}
                  {event.endsAt && ` - ${formatTime(event.endsAt)}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Where</dt>
                <dd className="text-slate-600">{event.location ?? '--'}</dd>
              </div>
            </dl>
            {event.description && (
              <p className="mt-3 whitespace-pre-line text-sm text-slate-600">{event.description}</p>
            )}
          </section>

          {event.followupNotes && (
            <section>
              <SectionHeader title="Post-event debrief" />
              <p className="whitespace-pre-line rounded-lg bg-teal-50 p-3 text-sm leading-relaxed text-teal-800">
                {event.followupNotes}
              </p>
            </section>
          )}

          <section>
            <SectionHeader title="Attendees" count={data?.attendees.length} />
            {data && data.attendees.length === 0 && (
              <p className="text-sm text-slate-500">Nobody linked yet.</p>
            )}
            <ul className="space-y-2">
              {(data?.attendees ?? []).map((contact) => (
                <li
                  key={contact.id}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 p-3"
                >
                  <Avatar name={contact.fullName} tone="teal" />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/contacts?open=${contact.id}`}
                      onClick={onClose}
                      className="block truncate font-semibold text-navy-800 hover:underline"
                    >
                      {contact.fullName}
                    </Link>
                    <p className="truncate text-xs text-slate-500">
                      {contact.organizationName ?? contact.email}
                    </p>
                  </div>
                  {canEdit && (
                    <button type="button" className="btn-quiet" onClick={() => removeAttendee(contact)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {canEdit && (
              <div className="mt-3 flex flex-col gap-2 rounded-lg bg-slate-50 p-3 sm:flex-row">
                <select
                  className="input"
                  value={addId}
                  onChange={(changeEvent) => setAddId(changeEvent.target.value)}
                  aria-label="Add an attendee"
                >
                  <option value="">Add someone who attended...</option>
                  {candidates.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.fullName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary shrink-0"
                  onClick={addAttendee}
                  disabled={busy || !addId}
                >
                  Add
                </button>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Adding someone writes "Attended {event.name} on {formatDate(event.startsAt)}" to their
              interaction history.
            </p>
          </section>
        </div>
      )}

      <Modal open={editing} title="Edit event" onClose={() => setEditing(false)} width="max-w-2xl">
        {event && (
          <EventForm
            initial={event}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              reload();
              onChanged();
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this event?"
        message="The event is removed from the calendar. Attendance notes already on contact timelines are kept."
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </SlideOver>
  );
}
