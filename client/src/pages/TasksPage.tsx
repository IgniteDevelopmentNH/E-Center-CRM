import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { TaskForm } from '../components/forms.tsx';
import { ConfirmDialog, Modal } from '../components/overlays.tsx';
import {
  Chip,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PRIORITY_TONES,
  Pagination,
  Select,
  StatusChip,
  TASK_STATUS_TONES,
} from '../components/ui.tsx';
import { ApiError, api, buildQuery, downloadCsv } from '../lib/api.ts';
import { TASK_PRIORITIES } from '../lib/constants.ts';
import { dueLabel, formatDate, humanise } from '../lib/format.ts';
import { useApi, useDebounced } from '../lib/hooks.ts';
import type { Task, TasksResponse, TeamMember } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';

const STATUS_FILTERS = [
  { value: 'incomplete', label: 'Still open' },
  { value: 'all', label: 'Everything' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'complete', label: 'Complete' },
];

const SORT_OPTIONS = [
  { value: 'due', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'contact', label: 'Contact' },
  { value: 'status', label: 'Status' },
];

export function TasksPage() {
  const { canEdit, user } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [term, setTerm] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') ?? 'incomplete');
  const [assignedTo, setAssignedTo] = useState(searchParams.get('assignedTo') ?? 'all');
  const [priority, setPriority] = useState('all');
  const [sort, setSort] = useState('due');
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(searchParams.get('new') === '1');
  const [editing, setEditing] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);

  const debouncedTerm = useDebounced(term, 300);

  const query = useMemo(
    () => buildQuery({ q: debouncedTerm.trim(), status, assignedTo, priority, sort, page, limit: 25 }),
    [debouncedTerm, status, assignedTo, priority, sort, page],
  );

  const { data, loading, error, reload } = useApi<TasksResponse>(`/tasks${query}`);
  const { data: users } = useApi<{ users: TeamMember[] }>('/settings/users');

  useEffect(() => {
    setPage(1);
  }, [debouncedTerm, status, assignedTo, priority, sort]);

  const clearNewParam = () => {
    if (searchParams.has('new')) {
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  };

  async function toggle(task: Task) {
    try {
      const response = await api.post<{ task: Task; nextOccurrence: Task | null }>(
        `/tasks/${task.id}/toggle`,
      );
      toast.success(
        response.nextOccurrence
          ? `Done. Next one due ${formatDate(response.nextOccurrence.dueDate)}.`
          : response.task.status === 'complete'
            ? 'Follow-up complete.'
            : 'Follow-up reopened.',
      );
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That follow-up could not be updated.');
    }
  }

  async function remove(task: Task) {
    setBusy(true);
    try {
      await api.delete(`/tasks/${task.id}`);
      toast.success('Follow-up deleted.');
      reload();
    } catch {
      toast.error('That follow-up could not be deleted.');
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  const tasks = data?.tasks ?? [];
  const summary = data?.summary;

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Follow-ups</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Who to follow up with, and when. Nothing depends on memory.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              downloadCsv(`/tasks/export.csv${query}`, 'ecenter-tasks.csv').catch(() =>
                toast.error('That export could not be generated.'),
              )
            }
          >
            Export CSV
          </button>
          {canEdit && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              + Add follow-up
            </button>
          )}
        </div>
      </header>

      {summary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            type="button"
            onClick={() => setStatus('overdue')}
            className={`card-interactive p-3 text-left ${summary.overdue > 0 ? 'border-urgent/40 bg-red-50' : ''}`}
          >
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Overdue</p>
            <p className={`text-2xl font-bold ${summary.overdue > 0 ? 'text-urgent' : 'text-slate-400'}`}>
              {summary.overdue}
            </p>
          </button>
          <button type="button" onClick={() => setStatus('incomplete')} className="card-interactive p-3 text-left">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Due in 7 days</p>
            <p className="text-2xl font-bold text-amber-600">{summary.dueSoon}</p>
          </button>
          <button type="button" onClick={() => setStatus('complete')} className="card-interactive p-3 text-left">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Complete</p>
            <p className="text-2xl font-bold text-success">{summary.complete}</p>
          </button>
          <button type="button" onClick={() => setStatus('all')} className="card-interactive p-3 text-left">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">All</p>
            <p className="text-2xl font-bold text-navy">{summary.total}</p>
          </button>
        </div>
      )}

      <div className="card mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative min-w-0 lg:col-span-2">
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            >
              ⌕
            </span>
            <input
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search follow-ups"
              aria-label="Search follow-ups"
              className="input pl-9"
            />
          </div>
          <Select
            value={status}
            options={STATUS_FILTERS}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filter by status"
          />
          <Select
            value={assignedTo}
            options={[
              ...(user ? [{ value: user.id, label: 'Assigned to me' }] : []),
              ...(users?.users ?? [])
                .filter((member) => member.id !== user?.id)
                .map((member) => ({ value: member.id, label: member.name })),
            ]}
            includeAll
            allLabel="Anyone"
            onChange={(event) => setAssignedTo(event.target.value)}
            aria-label="Filter by assignee"
          />
          <Select
            value={priority}
            options={TASK_PRIORITIES}
            includeAll
            allLabel="Any priority"
            onChange={(event) => setPriority(event.target.value)}
            aria-label="Filter by priority"
          />
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-slate-200 pt-3">
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">Sort by</span>
          <div className="w-52">
            <Select value={sort} options={SORT_OPTIONS} onChange={(event) => setSort(event.target.value)} />
          </div>
        </div>
      </div>

      {loading && !data && <LoadingBlock label="Loading follow-ups" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {data && tasks.length === 0 && (
        <EmptyState
          icon="✓"
          title={status === 'overdue' ? 'Nothing overdue' : 'No follow-ups here'}
          message={
            status === 'overdue'
              ? 'Nothing has slipped past its due date. Great job.'
              : 'Add a follow-up so the next step is not left to memory.'
          }
          action={
            canEdit ? (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                + Add follow-up
              </button>
            ) : undefined
          }
        />
      )}

      {tasks.length > 0 && (
        <>
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li
                key={task.id}
                className={`card flex flex-wrap items-start gap-3 p-4 ${
                  task.isOverdue ? 'border-l-4 border-l-urgent' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={task.status === 'complete'}
                  disabled={!canEdit}
                  onChange={() => toggle(task)}
                  aria-label={`Mark ${task.title} complete`}
                  className="mt-1 h-5 w-5 shrink-0 rounded border-slate-300 text-success focus:ring-success"
                />

                <div className="min-w-0 flex-1">
                  <p
                    className={`font-semibold ${
                      task.status === 'complete' ? 'text-slate-400 line-through' : 'text-navy-800'
                    }`}
                  >
                    {task.title}
                  </p>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                    <StatusChip value={task.displayStatus} tones={TASK_STATUS_TONES} />
                    <Chip tone={PRIORITY_TONES[task.priority] ?? 'slate'}>{humanise(task.priority)}</Chip>
                    <span
                      className={
                        task.isOverdue ? 'font-semibold text-urgent' : 'font-medium text-slate-500'
                      }
                    >
                      {dueLabel(task.dueDate)}
                    </span>
                    {task.contactId && (
                      <Link
                        to={`/contacts?open=${task.contactId}`}
                        className="font-semibold text-teal-700 hover:underline"
                      >
                        {task.contactName}
                      </Link>
                    )}
                    {task.assignedToName && <span className="text-slate-400">{task.assignedToName}</span>}
                    {task.recurrence !== 'none' && <Chip tone="teal">Repeats {task.recurrence}</Chip>}
                    {task.reminderEnabled && <span className="text-slate-400" title="Reminder set">⏰</span>}
                  </div>

                  {task.contextNotes && (
                    <p className="mt-2 border-l-2 border-slate-200 pl-2.5 text-sm text-slate-500">
                      {task.contextNotes}
                    </p>
                  )}
                </div>

                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" className="btn-quiet" onClick={() => setEditing(task)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-quiet text-urgent hover:bg-red-50"
                      onClick={() => setDeleting(task)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <Pagination
            page={data?.page ?? 1}
            limit={data?.limit ?? 25}
            total={data?.total ?? 0}
            onPageChange={setPage}
          />
        </>
      )}

      <Modal
        open={creating}
        title="Add a follow-up"
        onClose={() => {
          setCreating(false);
          clearNewParam();
        }}
        width="max-w-xl"
      >
        <TaskForm
          onCancel={() => {
            setCreating(false);
            clearNewParam();
          }}
          onSaved={() => {
            setCreating(false);
            clearNewParam();
            reload();
          }}
        />
      </Modal>

      <Modal open={!!editing} title="Edit follow-up" onClose={() => setEditing(null)} width="max-w-xl">
        {editing && (
          <TaskForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        title="Delete this follow-up?"
        message={`"${deleting?.title ?? ''}" will be removed from your lists.`}
        busy={busy}
        onConfirm={() => deleting && remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
