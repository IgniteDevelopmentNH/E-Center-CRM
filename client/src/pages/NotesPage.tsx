import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { NoteForm } from '../components/forms.tsx';
import { ConfirmDialog, Modal } from '../components/overlays.tsx';
import {
  Chip,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Pagination,
  Select,
  TextInput,
} from '../components/ui.tsx';
import { ApiError, api, buildQuery, downloadCsv } from '../lib/api.ts';
import { NOTE_TYPES } from '../lib/constants.ts';
import { formatDate, formatDateTime, humanise } from '../lib/format.ts';
import { useApi, useDebounced } from '../lib/hooks.ts';
import type { Contact, Note, NotesResponse, TeamMember } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';

export function NotesPage() {
  const { canEdit } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [term, setTerm] = useState('');
  const [noteType, setNoteType] = useState('all');
  const [tag, setTag] = useState('all');
  const [createdBy, setCreatedBy] = useState('all');
  const [contactId, setContactId] = useState(searchParams.get('contactId') ?? 'all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [showFilters, setShowFilters] = useState(!!searchParams.get('contactId'));
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(searchParams.get('new') === '1');
  const [editing, setEditing] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);

  const debouncedTerm = useDebounced(term, 300);

  const query = useMemo(
    () =>
      buildQuery({
        q: debouncedTerm.trim(),
        noteType,
        tag,
        createdBy,
        contactId: contactId === 'all' ? '' : contactId,
        from,
        to,
        order,
        page,
        limit: 25,
      }),
    [debouncedTerm, noteType, tag, createdBy, contactId, from, to, order, page],
  );

  const { data, loading, error, reload } = useApi<NotesResponse>(`/notes${query}`);
  const { data: contactData } = useApi<{ contacts: Contact[] }>('/contacts?limit=200&sort=name');
  const { data: users } = useApi<{ users: TeamMember[] }>('/settings/users');
  const { data: facets, reload: reloadFacets } = useApi<{ tags: { tag: string; count: number }[] }>(
    '/notes/facets',
  );

  useEffect(() => {
    setPage(1);
  }, [debouncedTerm, noteType, tag, createdBy, contactId, from, to, order]);

  const clearNewParam = () => {
    if (searchParams.has('new')) {
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  };

  async function removeNote(note: Note) {
    setBusy(true);
    try {
      await api.delete(`/notes/${note.id}`);
      toast.success('Note deleted.');
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That note could not be deleted.');
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  const activeFilters = [
    noteType !== 'all',
    tag !== 'all',
    createdBy !== 'all',
    contactId !== 'all',
    !!from,
    !!to,
  ].filter(Boolean).length;

  const notes = data?.notes ?? [];

  // Group the timeline by calendar day so the rail reads as a diary.
  const grouped = useMemo(() => {
    const groups: { day: string; notes: Note[] }[] = [];
    for (const note of notes) {
      const day = note.createdAt.slice(0, 10);
      const last = groups.at(-1);
      if (last && last.day === day) last.notes.push(note);
      else groups.push({ day, notes: [note] });
    }
    return groups;
  }, [notes]);

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Interaction history</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Every conversation, dated automatically. Nothing is typed in by hand.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              downloadCsv(`/notes/export.csv${query}`, 'ecenter-notes.csv').catch(() =>
                toast.error('That export could not be generated.'),
              )
            }
          >
            Export CSV
          </button>
          {canEdit && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              + Add note
            </button>
          )}
        </div>
      </header>

      <div className="card mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
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
              placeholder="Search note content, tags, or contact name"
              aria-label="Search notes"
              className="input pl-9"
            />
          </div>
          <div className="shrink-0 sm:w-44">
            <Select
              value={order}
              options={[
                { value: 'newest', label: 'Newest first' },
                { value: 'oldest', label: 'Oldest first' },
              ]}
              onChange={(event) => setOrder(event.target.value as 'newest' | 'oldest')}
              aria-label="Timeline order"
            />
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
          >
            Filters
            {activeFilters > 0 && (
              <span className="ml-1 rounded-full bg-teal px-1.5 text-xs text-white">{activeFilters}</span>
            )}
          </button>
        </div>

        {showFilters && (
          <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="label">Contact</span>
              <Select
                value={contactId}
                options={(contactData?.contacts ?? []).map((contact) => ({
                  value: contact.id,
                  label: contact.fullName,
                }))}
                includeAll
                allLabel="Everyone"
                onChange={(event) => setContactId(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">Type</span>
              <Select
                value={noteType}
                options={NOTE_TYPES}
                includeAll
                allLabel="Any type"
                onChange={(event) => setNoteType(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">Tag</span>
              <Select
                value={tag}
                options={(facets?.tags ?? []).map((entry) => ({
                  value: entry.tag,
                  label: `${entry.tag} (${entry.count})`,
                }))}
                includeAll
                allLabel="Any tag"
                onChange={(event) => setTag(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">Logged by</span>
              <Select
                value={createdBy}
                options={(users?.users ?? []).map((user) => ({ value: user.id, label: user.name }))}
                includeAll
                allLabel="Anyone"
                onChange={(event) => setCreatedBy(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">From</span>
              <TextInput type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="block">
              <span className="label">To</span>
              <TextInput type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>

            {activeFilters > 0 && (
              <button
                type="button"
                className="btn-quiet justify-self-start"
                onClick={() => {
                  setNoteType('all');
                  setTag('all');
                  setCreatedBy('all');
                  setContactId('all');
                  setFrom('');
                  setTo('');
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {loading && !data && <LoadingBlock label="Loading notes" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {data && notes.length === 0 && (
        <EmptyState
          icon="✎"
          title={debouncedTerm || activeFilters ? 'No notes match that' : 'No notes yet'}
          message={
            debouncedTerm || activeFilters
              ? 'Try a different search, or clear the filters.'
              : 'Log your first interaction and the relationship history starts here.'
          }
          action={
            canEdit && !debouncedTerm && !activeFilters ? (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                + Add note
              </button>
            ) : undefined
          }
        />
      )}

      {grouped.length > 0 && (
        <>
          <div className="space-y-6">
            {grouped.map((group) => (
              <section key={group.day}>
                <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-800">
                  {formatDate(group.day)}
                </h2>
                <ol className="timeline relative space-y-3 pl-6">
                  {group.notes.map((note) => (
                    <li key={note.id} className="relative">
                      <span
                        className={`absolute -left-6 top-3 h-4 w-4 rounded-full border-2 border-white ${
                          note.source === 'event' ? 'bg-teal-200' : 'bg-teal'
                        }`}
                        aria-hidden="true"
                      />
                      <article className="card p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate font-bold text-navy-800">{note.contactName}</h3>
                            <p className="text-xs font-semibold text-teal-800">
                              {formatDateTime(note.createdAt)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Chip tone="slate">{humanise(note.noteType)}</Chip>
                            {note.source === 'event' && <Chip tone="teal">Auto</Chip>}
                            {canEdit && note.source === 'manual' && (
                              <>
                                <button type="button" className="btn-quiet" onClick={() => setEditing(note)}>
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn-quiet text-urgent hover:bg-red-50"
                                  onClick={() => setDeleting(note)}
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                          {note.content}
                        </p>

                        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2 text-xs text-slate-400">
                          {note.tags.map((noteTag) => (
                            <Chip key={noteTag} tone="navy">
                              {noteTag}
                            </Chip>
                          ))}
                          <span className="ml-auto">
                            {note.createdByName ?? 'System'} · {note.wordCount}{' '}
                            {note.wordCount === 1 ? 'word' : 'words'}
                          </span>
                        </div>
                      </article>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>

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
        title="Add a note"
        onClose={() => {
          setCreating(false);
          clearNewParam();
        }}
        width="max-w-xl"
      >
        <NoteForm
          contacts={contactData?.contacts}
          onCancel={() => {
            setCreating(false);
            clearNewParam();
          }}
          onSaved={() => {
            setCreating(false);
            clearNewParam();
            reload();
            reloadFacets();
          }}
        />
      </Modal>

      <Modal open={!!editing} title="Edit note" onClose={() => setEditing(null)} width="max-w-xl">
        {editing && (
          <NoteForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
              reloadFacets();
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        title="Delete this note?"
        message="This interaction will be removed from the timeline."
        busy={busy}
        onConfirm={() => deleting && removeNote(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
