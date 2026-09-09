import { Link, useNavigate } from 'react-router-dom';
import {
  Chip,
  EVENT_TYPE_TONES,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PRIORITY_TONES,
  SectionHeader,
  StatCard,
  StatusChip,
  TASK_STATUS_TONES,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { dueLabel, formatDate, formatRelative, formatTime, humanise } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import type { DashboardResponse, Task } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';

export function DashboardPage() {
  const { user, canEdit } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi<DashboardResponse>('/dashboard');

  async function toggle(task: Task) {
    try {
      const response = await api.post<{ task: Task; nextOccurrence: Task | null }>(
        `/tasks/${task.id}/toggle`,
      );
      toast.success(
        response.nextOccurrence
          ? `Done. Next one due ${formatDate(response.nextOccurrence.dueDate)}.`
          : 'Follow-up complete.',
      );
      reload();
    } catch {
      toast.error('That follow-up could not be updated.');
    }
  }

  if (loading && !data) return <LoadingBlock label="Loading your dashboard" />;
  if (error) return <ErrorBlock message={error} onRetry={reload} />;
  if (!data) return null;

  const { stats } = data;
  const firstName = user?.name.split(' ')[0] ?? 'there';

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-navy-800">Good to see you, {firstName}</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          The ECenter at a glance -- what needs attention, and what is coming up.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Active contacts"
          value={stats.activeContacts}
          detail={`${stats.totalContacts} total · ${stats.organizations} organizations`}
          onClick={() => navigate('/contacts?status=active')}
        />
        <StatCard
          label="Due this week"
          value={stats.tasksDueThisWeek}
          detail="Next 7 days"
          tone="teal"
          onClick={() => navigate('/tasks')}
        />
        <StatCard
          label="Upcoming events"
          value={stats.upcomingEvents}
          detail={
            stats.nextEventAt
              ? `Next: ${formatDate(stats.nextEventAt)}`
              : 'Nothing scheduled'
          }
          onClick={() => navigate('/events')}
        />
        <StatCard
          label="Team members"
          value={stats.teamMembers}
          detail="Shared visibility"
          onClick={() => navigate('/settings')}
        />
      </div>

      {data.overdueTasks.length > 0 && (
        <section className="card overflow-hidden border-urgent/40">
          <div className="flex items-center gap-2 bg-urgent px-4 py-2.5 text-white">
            <span aria-hidden="true">!</span>
            <h2 className="text-sm font-bold uppercase tracking-wide">
              {data.overdueTasks.length} overdue follow-up{data.overdueTasks.length === 1 ? '' : 's'}
            </h2>
            <Link to="/tasks?status=overdue" className="ml-auto text-xs font-semibold underline">
              View all
            </Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {data.overdueTasks.slice(0, 6).map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {canEdit && (
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => toggle(task)}
                    aria-label={`Mark ${task.title} complete`}
                    className="h-4 w-4 rounded border-slate-300 text-success focus:ring-success"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-navy-800">{task.title}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-urgent">{dueLabel(task.dueDate)}</span>
                    {task.contactId && (
                      <Link
                        to={`/contacts?open=${task.contactId}`}
                        className="font-semibold text-teal-700 hover:underline"
                      >
                        {task.contactName}
                      </Link>
                    )}
                    {task.assignedToName && <span className="text-slate-400">{task.assignedToName}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <SectionHeader
            title="This week's focus"
            count={data.thisWeek.length}
            action={
              <Link to="/tasks" className="text-xs font-semibold text-teal-700 hover:underline">
                View all
              </Link>
            }
          />
          {data.thisWeek.length === 0 ? (
            <EmptyState
              icon="✓"
              title="No follow-ups this week"
              message="Nothing is due in the next seven days -- great job staying on top of it."
            />
          ) : (
            <ul className="space-y-2">
              {data.thisWeek.map((task) => (
                <li key={task.id} className="card flex flex-wrap items-start gap-3 p-3">
                  {canEdit && (
                    <input
                      type="checkbox"
                      checked={task.status === 'complete'}
                      onChange={() => toggle(task)}
                      aria-label={`Mark ${task.title} complete`}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-success focus:ring-success"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-navy-800">{task.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <StatusChip value={task.displayStatus} tones={TASK_STATUS_TONES} />
                      <Chip tone={PRIORITY_TONES[task.priority] ?? 'slate'}>
                        {humanise(task.priority)}
                      </Chip>
                      <span className="text-slate-500">{dueLabel(task.dueDate)}</span>
                      {task.contactId && (
                        <Link
                          to={`/contacts?open=${task.contactId}`}
                          className="font-semibold text-teal-700 hover:underline"
                        >
                          {task.contactName}
                        </Link>
                      )}
                      {task.assignedToName && (
                        <span className="text-slate-400">{task.assignedToName}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-6">
          <section>
            <SectionHeader
              title="Upcoming events"
              count={data.upcomingEvents.length}
              action={
                <Link to="/events" className="text-xs font-semibold text-teal-700 hover:underline">
                  View all
                </Link>
              }
            />
            {data.upcomingEvents.length === 0 ? (
              <p className="card p-4 text-sm text-slate-500">Nothing in the next 30 days.</p>
            ) : (
              <ul className="space-y-2">
                {data.upcomingEvents.slice(0, 5).map((event) => (
                  <li key={event.id}>
                    <Link to={`/events?open=${event.id}`} className="card-interactive block p-3">
                      <p className="font-semibold text-navy-800">{event.name}</p>
                      <p className="text-xs text-slate-500">
                        {formatDate(event.startsAt)} · {formatTime(event.startsAt)}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <StatusChip value={event.eventType} tones={EVENT_TYPE_TONES} />
                        <Chip tone="slate">{event.attendeeCount} attending</Chip>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHeader title="Team" count={data.team.length} />
            <ul className="card divide-y divide-slate-100">
              {data.team.map((member) => (
                <li key={member.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-navy-800">{member.name}</p>
                    <p className="truncate text-xs capitalize text-slate-400">{member.role}</p>
                  </div>
                  <Link
                    to={`/tasks?assignedTo=${member.id}&status=incomplete`}
                    className="shrink-0 text-right"
                  >
                    <span className="block text-lg font-bold text-navy">{member.openTaskCount}</span>
                    <span className="block text-[10px] uppercase tracking-wide text-slate-400">open</span>
                  </Link>
                  {!!member.overdueTaskCount && member.overdueTaskCount > 0 && (
                    <Chip tone="red">{member.overdueTaskCount} late</Chip>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <section>
        <SectionHeader title="Recent activity" />
        {data.activity.length === 0 ? (
          <p className="card p-4 text-sm text-slate-500">Nothing logged in the last seven days.</p>
        ) : (
          <ul className="card max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {data.activity.map((item) => (
              <li key={`${item.type}-${item.entityId}`} className="flex items-start gap-3 p-3">
                <span
                  className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs ${
                    item.type === 'note'
                      ? 'bg-teal-50 text-teal-700'
                      : item.type === 'contact'
                        ? 'bg-navy-50 text-navy-600'
                        : 'bg-green-50 text-success'
                  }`}
                  aria-hidden="true"
                >
                  {item.type === 'note' ? '✎' : item.type === 'contact' ? '☺' : '✓'}
                </span>
                <div className="min-w-0 flex-1">
                  {item.contactId ? (
                    <Link
                      to={`/contacts?open=${item.contactId}`}
                      className="font-semibold text-navy-800 hover:underline"
                    >
                      {item.title}
                    </Link>
                  ) : (
                    <p className="font-semibold text-navy-800">{item.title}</p>
                  )}
                  {item.detail && <p className="text-sm text-slate-500">{item.detail}</p>}
                </div>
                <span className="shrink-0 text-xs text-slate-400">{formatRelative(item.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
