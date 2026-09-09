import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ContactForm, NoteForm, TaskForm } from '../components/forms.tsx';
import { ConfirmDialog, Modal, SlideOver } from '../components/overlays.tsx';
import {
  CONTACT_STATUS_TONES,
  Chip,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PRIORITY_TONES,
  SectionHeader,
  Spinner,
  StatusChip,
  TASK_STATUS_TONES,
  TagChip,
} from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { dueLabel, formatBytes, formatDate, formatDateTime, formatRelative, humanise } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import type { Contact, CrmDocument, Note, Task } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';

export function ContactPanel({
  contactId,
  onClose,
  onChanged,
}: {
  contactId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { canEdit } = useAuth();
  const toast = useToast();

  const { data, loading, error, reload } = useApi<{ contact: Contact }>(`/contacts/${contactId}`);
  const notes = useApi<{ notes: Note[] }>(`/notes?contactId=${contactId}&limit=100`);
  const tasks = useApi<{ tasks: Task[] }>(`/tasks?contactId=${contactId}&limit=100`);
  const documents = useApi<{ documents: CrmDocument[] }>(`/documents?contactId=${contactId}`);

  const [editing, setEditing] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteNote, setDeleteNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const contact = data?.contact;

  function refreshAll() {
    reload();
    notes.reload();
    tasks.reload();
    onChanged();
  }

  async function removeContact() {
    setBusy(true);
    try {
      await api.delete(`/contacts/${contactId}`);
      toast.success('Contact deleted.');
      onChanged();
      onClose();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That contact could not be deleted.');
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  async function removeNote(note: Note) {
    setBusy(true);
    try {
      await api.delete(`/notes/${note.id}`);
      toast.success('Note deleted.');
      notes.reload();
      reload();
      onChanged();
    } catch {
      toast.error('That note could not be deleted.');
    } finally {
      setBusy(false);
      setDeleteNote(null);
    }
  }

  async function toggleTask(task: Task) {
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
      tasks.reload();
      onChanged();
    } catch {
      toast.error('That follow-up could not be updated.');
    }
  }

  async function uploadDocument(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('contactId', contactId);
      await api.post('/documents', form);
      toast.success(`${file.name} uploaded.`);
      documents.reload();
      reload();
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That file could not be uploaded.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function downloadDocument(document_: CrmDocument) {
    try {
      const response = await api.get<{ url: string }>(`/documents/${document_.id}/download`);
      const link = document.createElement('a');
      link.href = response.url;
      link.rel = 'noopener';
      link.target = '_blank';
      document.body.append(link);
      link.click();
      link.remove();
    } catch {
      toast.error('That download link could not be created.');
    }
  }

  async function removeDocument(document_: CrmDocument) {
    try {
      await api.delete(`/documents/${document_.id}`);
      toast.success('Document deleted.');
      documents.reload();
      reload();
      onChanged();
    } catch {
      toast.error('That document could not be deleted.');
    }
  }

  return (
    <SlideOver
      open
      title={contact?.fullName ?? 'Contact'}
      subtitle={
        contact ? (
          <span>
            {contact.orgRole && `${contact.orgRole}, `}
            {contact.organizationName ?? contact.email}
          </span>
        ) : undefined
      }
      onClose={onClose}
      width="max-w-2xl"
      footer={
        canEdit && contact ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => setAddingNote(true)}>
              + Add note
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAddingTask(true)}>
              + Add follow-up
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              Edit
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
      {loading && !contact && <LoadingBlock label="Loading contact" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {contact && (
        <div className="space-y-6">
          {contact.isStudentFounder && (
            <p className="rounded-lg bg-gold-100 px-3 py-2 text-xs text-gold-600">
              <strong>Student founder.</strong> Tracked as a business owner -- business and founder
              details only, no personal or student information.
            </p>
          )}

          <section>
            <SectionHeader title="How we connected" />
            {contact.howWeConnected ? (
              <p className="whitespace-pre-line rounded-lg bg-navy-50 p-3 text-sm leading-relaxed text-navy-900">
                {contact.howWeConnected}
              </p>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500">
                No relationship history recorded yet.
                {canEdit && (
                  <button type="button" className="ml-1 font-semibold text-teal underline" onClick={() => setEditing(true)}>
                    Add it
                  </button>
                )}
              </p>
            )}
          </section>

          <section>
            <SectionHeader title="Details" />
            <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Email</dt>
                <dd>
                  <a className="text-teal-700 hover:underline" href={`mailto:${contact.email}`}>
                    {contact.email}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Phone</dt>
                <dd>
                  {contact.phone ? (
                    <a className="text-teal-700 hover:underline" href={`tel:${contact.phone}`}>
                      {contact.phone}
                    </a>
                  ) : (
                    <span className="text-slate-400">--</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Organization
                </dt>
                <dd>
                  {contact.organizationId ? (
                    <Link
                      to={`/organizations?open=${contact.organizationId}`}
                      className="text-teal-700 hover:underline"
                      onClick={onClose}
                    >
                      {contact.organizationName}
                    </Link>
                  ) : (
                    <span className="text-slate-400">--</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</dt>
                <dd className="mt-0.5">
                  <StatusChip value={contact.status} tones={CONTACT_STATUS_TONES} />
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Added</dt>
                <dd className="text-slate-600">
                  {formatDate(contact.dateAdded)}
                  {contact.createdByName && ` by ${contact.createdByName}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Last interaction
                </dt>
                <dd className="text-slate-600">{formatRelative(contact.lastInteractionAt)}</dd>
              </div>
            </dl>

            {contact.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {contact.tags.map((tag) => (
                  <TagChip key={tag} tag={tag} />
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionHeader
              title="Open follow-ups"
              count={(tasks.data?.tasks ?? []).filter((task) => task.status !== 'complete').length}
            />
            {tasks.loading && !tasks.data && <Spinner label="Loading follow-ups" />}
            {tasks.data && tasks.data.tasks.length === 0 && (
              <p className="text-sm text-slate-500">No follow-ups for this contact.</p>
            )}
            <ul className="space-y-2">
              {(tasks.data?.tasks ?? []).map((task) => (
                <li key={task.id} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
                  <input
                    type="checkbox"
                    checked={task.status === 'complete'}
                    disabled={!canEdit}
                    onChange={() => toggleTask(task)}
                    aria-label={`Mark ${task.title} complete`}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-success focus:ring-success"
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm font-semibold ${
                        task.status === 'complete' ? 'text-slate-400 line-through' : 'text-navy-800'
                      }`}
                    >
                      {task.title}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <StatusChip value={task.displayStatus} tones={TASK_STATUS_TONES} />
                      <Chip tone={PRIORITY_TONES[task.priority] ?? 'slate'}>{humanise(task.priority)}</Chip>
                      <span className={task.isOverdue ? 'font-semibold text-urgent' : 'text-slate-500'}>
                        {dueLabel(task.dueDate)}
                      </span>
                      {task.assignedToName && <span className="text-slate-400">{task.assignedToName}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <SectionHeader
              title="Interaction history"
              count={notes.data?.notes.length}
              action={
                canEdit ? (
                  <button type="button" className="btn-quiet" onClick={() => setAddingNote(true)}>
                    + Add note
                  </button>
                ) : undefined
              }
            />
            {notes.loading && !notes.data && <Spinner label="Loading notes" />}
            {notes.data && notes.data.notes.length === 0 && (
              <EmptyState
                icon="✎"
                title="No notes yet"
                message="Log the first interaction so the relationship history starts building."
                action={
                  canEdit ? (
                    <button type="button" className="btn-primary" onClick={() => setAddingNote(true)}>
                      + Add note
                    </button>
                  ) : undefined
                }
              />
            )}

            {notes.data && notes.data.notes.length > 0 && (
              <ol className="timeline relative space-y-4 pl-6">
                {notes.data.notes.map((note) => (
                  <li key={note.id} className="relative">
                    <span
                      className={`absolute -left-6 top-1.5 h-4 w-4 rounded-full border-2 border-white ${
                        note.source === 'event' ? 'bg-teal-200' : 'bg-teal'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-teal-800">
                          {formatDateTime(note.createdAt)}
                        </p>
                        <div className="flex items-center gap-1">
                          <Chip tone="slate">{humanise(note.noteType)}</Chip>
                          {canEdit && note.source === 'manual' && (
                            <>
                              <button
                                type="button"
                                className="btn-quiet"
                                onClick={() => setEditingNote(note)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn-quiet text-urgent hover:bg-red-50"
                                onClick={() => setDeleteNote(note)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                        {note.content}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                        {note.tags.map((tag) => (
                          <Chip key={tag} tone="navy">
                            {tag}
                          </Chip>
                        ))}
                        <span className="ml-auto">
                          {note.createdByName ?? 'System'} · {note.wordCount}{' '}
                          {note.wordCount === 1 ? 'word' : 'words'}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section>
            <SectionHeader
              title="Documents"
              count={documents.data?.documents.length}
              action={
                canEdit ? (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) uploadDocument(file);
                      }}
                    />
                    <button
                      type="button"
                      className="btn-quiet"
                      disabled={uploading}
                      onClick={() => fileInput.current?.click()}
                    >
                      {uploading ? 'Uploading...' : '+ Add document'}
                    </button>
                  </>
                ) : undefined
              }
            />
            {documents.data && documents.data.documents.length === 0 && (
              <p className="text-sm text-slate-500">
                No documents attached. PDF, image, Word, Excel and text files are accepted.
              </p>
            )}
            <ul className="space-y-2">
              {(documents.data?.documents ?? []).map((document_) => (
                <li
                  key={document_.id}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 p-3"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-navy-50 text-navy-600" aria-hidden="true">
                    ▤
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-navy-800">{document_.fileName}</p>
                    <p className="text-xs text-slate-500">
                      {formatBytes(document_.fileSize)} · {formatDate(document_.createdAt)}
                      {document_.uploadedByName && ` · ${document_.uploadedByName}`}
                    </p>
                  </div>
                  <button type="button" className="btn-quiet" onClick={() => downloadDocument(document_)}>
                    Download
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn-quiet text-urgent hover:bg-red-50"
                      onClick={() => removeDocument(document_)}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <Modal open={editing} title="Edit contact" onClose={() => setEditing(false)} width="max-w-2xl">
        {contact && (
          <ContactForm
            initial={contact}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              refreshAll();
            }}
          />
        )}
      </Modal>

      <Modal open={addingNote} title="Add a note" onClose={() => setAddingNote(false)} width="max-w-xl">
        <NoteForm
          contactId={contactId}
          onCancel={() => setAddingNote(false)}
          onSaved={() => {
            setAddingNote(false);
            refreshAll();
          }}
        />
      </Modal>

      <Modal open={!!editingNote} title="Edit note" onClose={() => setEditingNote(null)} width="max-w-xl">
        {editingNote && (
          <NoteForm
            initial={editingNote}
            contactId={contactId}
            onCancel={() => setEditingNote(null)}
            onSaved={() => {
              setEditingNote(null);
              refreshAll();
            }}
          />
        )}
      </Modal>

      <Modal open={addingTask} title="Add a follow-up" onClose={() => setAddingTask(false)} width="max-w-xl">
        <TaskForm
          contactId={contactId}
          onCancel={() => setAddingTask(false)}
          onSaved={() => {
            setAddingTask(false);
            refreshAll();
          }}
        />
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this contact?"
        message={`${contact?.fullName ?? 'This contact'} and their notes and follow-ups will be removed from your lists. The records are retained for the audit trail.`}
        busy={busy}
        onConfirm={removeContact}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={!!deleteNote}
        title="Delete this note?"
        message="This interaction will be removed from the timeline. This cannot be undone from the app."
        busy={busy}
        onConfirm={() => deleteNote && removeNote(deleteNote)}
        onCancel={() => setDeleteNote(null)}
      />
    </SlideOver>
  );
}
