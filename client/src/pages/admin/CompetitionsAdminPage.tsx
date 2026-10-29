import { useState } from 'react';
import type { FormEvent } from 'react';
import { ConfirmDialog, Modal } from '../../components/overlays.tsx';
import { Chip, EmptyState, ErrorBlock, Field, LoadingBlock, TextArea, TextInput } from '../../components/ui.tsx';
import type { Tone } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { formatDate, formatTime, toDateTimeInput } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { Competition } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

const STATUS: Record<Competition['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  published: { label: 'Published', tone: 'green' },
  archived: { label: 'Archived', tone: 'slate' },
};

interface DeadlineDraft {
  key: number;
  label: string;
  dueAt: string;
}

let nextKey = 1;

function CompetitionEditor({
  competition,
  onClose,
  onSaved,
}: {
  competition: Competition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(competition?.title ?? '');
  const [summary, setSummary] = useState(competition?.summary ?? '');
  const [description, setDescription] = useState(competition?.description ?? '');
  const [prize, setPrize] = useState(competition?.prize ?? '');
  const [eligibility, setEligibility] = useState(competition?.eligibility ?? '');
  const [linkUrl, setLinkUrl] = useState(competition?.linkUrl ?? '');
  const [deadlines, setDeadlines] = useState<DeadlineDraft[]>(
    competition?.deadlines.length
      ? competition.deadlines.map((d) => ({ key: nextKey++, label: d.label, dueAt: toDateTimeInput(d.dueAt) }))
      : [{ key: nextKey++, label: 'Applications due', dueAt: '' }],
  );
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const errorFor = (field: string) => (error?.field === field ? error.message : null);

  const update = (key: number, change: Partial<DeadlineDraft>) =>
    setDeadlines((list) => list.map((d) => (d.key === key ? { ...d, ...change } : d)));

  async function save(publish: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title,
        summary,
        description,
        prize,
        eligibility,
        linkUrl,
        deadlines: deadlines
          .filter((d) => d.dueAt)
          .map((d) => ({ label: d.label, dueAt: new Date(d.dueAt).toISOString() })),
        publish,
      };
      let saved = competition
        ? (await api.put<{ competition: Competition }>(`/admin/competitions/${competition.id}`, payload)).competition
        : (await api.post<{ competition: Competition }>('/admin/competitions', payload)).competition;
      if (competition && publish && saved.status !== 'published') {
        saved = (await api.post<{ competition: Competition }>(`/admin/competitions/${saved.id}/publish`)).competition;
      }
      if (image) {
        const form = new FormData();
        form.set('file', image);
        await api.post(`/admin/competitions/${saved.id}/image`, form);
      }
      toast.success(publish ? 'Competition published.' : 'Saved.');
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? { message: caught.message, field: caught.field } : { message: 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={competition ? 'Edit competition' : 'New competition'}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {competition?.status !== 'published' && (
            <button type="button" className="btn-secondary" onClick={() => save(false)} disabled={busy}>Save draft</button>
          )}
          <button type="button" className="btn-primary" onClick={() => save(true)} disabled={busy}>
            {busy ? 'Saving...' : competition?.status === 'published' ? 'Save changes' : 'Publish'}
          </button>
        </div>
      }
    >
      <form onSubmit={(e) => save(false, e)} className="space-y-4" noValidate>
        <Field label="Title" required error={errorFor('Title')}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} invalid={!!errorFor('Title')} />
        </Field>
        <Field label="Summary" hint="One or two lines shown in the list." error={errorFor('Summary')}>
          <TextInput value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Prize" error={errorFor('Prize')}>
            <TextInput value={prize} onChange={(e) => setPrize(e.target.value)} maxLength={300} placeholder="e.g. $10,000 in seed funding" />
          </Field>
          <Field label="Application link" error={errorFor('Application link')}>
            <TextInput type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" invalid={!!errorFor('Application link')} />
          </Field>
        </div>
        <Field label="Who can enter" error={errorFor('Who can enter')}>
          <TextArea value={eligibility} onChange={(e) => setEligibility(e.target.value)} rows={2} maxLength={1000} />
        </Field>
        <Field label="Details" error={errorFor('Details')}>
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={10000} />
        </Field>

        <fieldset className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold text-navy-800">Deadlines</legend>
          <p className="mb-2 text-xs text-slate-500">Each deadline also appears in Upcoming events once the competition is published.</p>
          <ul className="space-y-3">
            {deadlines.map((deadline) => (
              <li key={deadline.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="Name">
                  <TextInput value={deadline.label} onChange={(e) => update(deadline.key, { label: e.target.value })} maxLength={120} />
                </Field>
                <Field label="Date & time" error={errorFor('Deadline date')}>
                  <TextInput type="datetime-local" value={deadline.dueAt} onChange={(e) => update(deadline.key, { dueAt: e.target.value })} />
                </Field>
                <button
                  type="button"
                  className="btn-quiet text-urgent"
                  onClick={() => setDeadlines((list) => list.filter((d) => d.key !== deadline.key))}
                  aria-label={`Remove ${deadline.label || 'deadline'}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {deadlines.length < 10 && (
            <button
              type="button"
              className="btn-ghost mt-3"
              onClick={() => setDeadlines((list) => [...list, { key: nextKey++, label: '', dueAt: '' }])}
            >
              + Add deadline
            </button>
          )}
        </fieldset>

        <div>
          <p className="label">Image</p>
          {competition?.imageUrl && !image && <img src={competition.imageUrl} alt="" className="mb-2 h-16 w-28 rounded-lg object-cover" />}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setImage(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-[40px] file:rounded-lg file:border-0 file:bg-navy-50 file:px-3 file:font-semibold file:text-navy-700"
            aria-label="Choose an image"
          />
          {errorFor('File') && <p className="mt-1 text-xs font-semibold text-urgent">{errorFor('File')}</p>}
        </div>
        {error && !error.field && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">{error.message}</p>}
      </form>
    </Modal>
  );
}

/** Admin > Competitions. Owners/editors post ECenter competitions; viewers read. */
export function CompetitionsAdminPage() {
  const { canEdit } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ competitions: Competition[] }>('/admin/competitions');
  const [editing, setEditing] = useState<Competition | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Competition | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(competition: Competition, action: 'publish' | 'unpublish' | 'archive') {
    try {
      await api.post(`/admin/competitions/${competition.id}/${action}`);
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/admin/competitions/${deleting.id}`);
      toast.success('Competition deleted.');
      setDeleting(null);
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Competitions</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Post upcoming ECenter competitions. Published ones are visible to members and guests, and their deadlines show in Upcoming events.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>+ New competition</button>
        )}
      </header>

      {loading && !data && <LoadingBlock label="Loading competitions" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.competitions.length === 0 && (
        <EmptyState title="No competitions yet" message="Add a competition with its deadlines to share it with the community." icon="★" />
      )}

      <ul className="space-y-3">
        {data?.competitions.map((competition) => (
          <li key={competition.id} className="card p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {competition.imageUrl && <img src={competition.imageUrl} alt="" className="h-32 w-full rounded-lg object-cover sm:h-20 sm:w-32" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={STATUS[competition.status].tone}>{STATUS[competition.status].label}</Chip>
                </div>
                <h2 className="mt-1 text-lg font-bold text-navy-800">{competition.title}</h2>
                {competition.summary && <p className="text-sm text-slate-600">{competition.summary}</p>}
                <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
                  {competition.deadlines.map((d) => (
                    <li key={d.id} className={d.passed ? 'line-through' : ''}>
                      {d.label}: {formatDate(d.dueAt)} {formatTime(d.dueAt)}
                    </li>
                  ))}
                  {competition.deadlines.length === 0 && <li>No deadlines</li>}
                </ul>
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-1 sm:flex-col sm:items-end">
                  <button type="button" className="btn-ghost" onClick={() => setEditing(competition)}>Edit</button>
                  {competition.status === 'published' ? (
                    <button type="button" className="btn-quiet" onClick={() => act(competition, 'unpublish')}>Unpublish</button>
                  ) : (
                    <button type="button" className="btn-quiet" onClick={() => act(competition, 'publish')}>Publish</button>
                  )}
                  {competition.status !== 'archived' && (
                    <button type="button" className="btn-quiet" onClick={() => act(competition, 'archive')}>Archive</button>
                  )}
                  <button type="button" className="btn-quiet text-urgent" onClick={() => setDeleting(competition)}>Delete</button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <CompetitionEditor
          competition={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete competition"
        message={`Delete "${deleting?.title ?? ''}"? It disappears from the portal and Upcoming events.`}
        busy={busy}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
