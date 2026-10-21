import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Combobox } from '../../components/Combobox.tsx';
import { MentionTextarea, plainText } from '../../components/mentions.tsx';
import { ConfirmDialog, Modal } from '../../components/overlays.tsx';
import { Checkbox, Chip, EmptyState, ErrorBlock, Field, LoadingBlock, Pagination, TextArea, TextInput } from '../../components/ui.tsx';
import type { Tone } from '../../components/ui.tsx';
import { ApiError, api, buildQuery } from '../../lib/api.ts';
import { formatDate, formatDateTime, humanise, toDateTimeInput, truncate } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { AdminPost, CrmEvent } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

const STATUS: Record<AdminPost['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Awaiting approval', tone: 'amber' },
  draft: { label: 'Draft', tone: 'slate' },
  published: { label: 'Published', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  archived: { label: 'Archived', tone: 'slate' },
};
const FILTERS = [
  { value: 'all', label: 'All posts' },
  { value: 'pending', label: 'Awaiting approval' },
  { value: 'draft', label: 'Drafts' },
  { value: 'published', label: 'Published' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'archived', label: 'Archived' },
];

interface ListResponse {
  posts: AdminPost[];
  total: number;
  limit: number;
  pendingCount: number;
}

/** Admin-authored feed plus moderation of member posts. Owners/editors write; viewers read. */
export function PostsAdminPage() {
  const { canEdit } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminPost | 'new' | null>(null);
  const [confirm, setConfirm] = useState<{ post: AdminPost; action: 'archive' | 'delete' | 'notify' } | null>(null);
  const [rejecting, setRejecting] = useState<AdminPost | null>(null);
  const [rsvpFor, setRsvpFor] = useState<AdminPost | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, loading, error, reload } = useApi<ListResponse>(`/admin/posts${buildQuery({ status, page, limit: 20 })}`);

  async function act(post: AdminPost, action: string, body?: unknown, success?: string) {
    setBusyId(post.id);
    try {
      const response =
        action === 'delete'
          ? await api.delete<{ ok: boolean }>(`/admin/posts/${post.id}`)
          : await api.post<{ queued?: number }>(`/admin/posts/${post.id}/${action}`, body);
      if (action === 'notify') {
        toast.success(`Emailing ${(response as { queued?: number }).queued ?? 0} members. Emails go out over the next few minutes.`);
      } else if (success) {
        toast.success(success);
      }
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusyId(null);
      setConfirm(null);
      setRejecting(null);
    }
  }

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Posts</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            News, events and member posts for the community feed. Only published posts are visible to students and mentors.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            + New post
          </button>
        )}
      </header>

      {data && data.pendingCount > 0 && status !== 'pending' && (
        <button
          type="button"
          onClick={() => { setStatus('pending'); setPage(1); }}
          className="mb-4 flex w-full items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-left text-sm font-semibold text-amber-800 hover:bg-amber-100"
        >
          {data.pendingCount} {data.pendingCount === 1 ? 'member post is' : 'member posts are'} waiting for approval →
        </button>
      )}

      <div className="scroll-x mb-5">
        <div className="flex gap-2" role="group" aria-label="Filter posts">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={status === filter.value}
              onClick={() => { setStatus(filter.value); setPage(1); }}
              className={`chip min-h-[36px] shrink-0 border px-3 ${
                status === filter.value ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-navy-200'
              }`}
            >
              {filter.label}
              {filter.value === 'pending' && !!data?.pendingCount && (
                <span className="rounded-full bg-amber-500 px-1.5 text-[11px] text-white">{data.pendingCount}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <LoadingBlock label="Loading posts" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.posts.length === 0 && (
        <EmptyState
          title={status === 'pending' ? 'Nothing waiting for approval' : 'No posts here yet'}
          message={status === 'pending' ? 'Member posts that need review will appear here.' : 'Write a post to share news, programs and events with students and mentors.'}
          icon="▤"
        />
      )}

      <ul className="space-y-3">
        {data?.posts.map((post) => (
          <li key={post.id} className="card p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {post.imageUrl && <img src={post.imageUrl} alt="" className="h-32 w-full rounded-lg object-cover sm:h-20 sm:w-32" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={STATUS[post.status].tone}>{STATUS[post.status].label}</Chip>
                  {post.isEvent && <Chip tone="teal">Event</Chip>}
                  {post.authorKind === 'member' && <Chip tone="navy">Member post</Chip>}
                </div>
                <h2 className="mt-1.5 font-bold text-navy-800">{post.title}</h2>
                <p className="mt-1 text-sm text-slate-600">{truncate(plainText(post.body), 220)}</p>
                <p className="mt-1.5 text-xs text-slate-500">
                  {post.authorName ? `By ${post.authorName}${post.authorKind === 'member' ? ` (${humanise(post.authorAccountType)})` : ''} · ` : ''}
                  {post.publishedAt ? `Published ${formatDateTime(post.publishedAt)}` : `Updated ${formatDateTime(post.updatedAt)}`}
                  {post.eventDetails ? ` · Event ${formatDate(post.eventDetails.startsAt)}` : ''}
                  {post.eventName ? ` · Linked event: ${post.eventName}` : ''}
                </p>
                {post.status === 'published' && (
                  <p className="mt-1 text-xs text-slate-500">
                    ♥ {post.likeCount} · 💬 {post.commentCount}
                    {post.eventDetails?.rsvpEnabled && (
                      <>
                        {' · '}
                        <button type="button" className="font-semibold text-teal-700 hover:underline" onClick={() => setRsvpFor(post)}>
                          {post.rsvpCount} going
                        </button>
                      </>
                    )}
                    {post.notifiedAt && ` · Emailed to members ${formatDate(post.notifiedAt)}`}
                    {post.revisionCount > 0 && ` · ${post.revisionCount} change${post.revisionCount === 1 ? '' : 's'} logged`}
                  </p>
                )}
                {post.status === 'rejected' && post.reviewNote && (
                  <p className="mt-1 text-xs text-urgent">Rejection note: “{post.reviewNote}”</p>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {post.status === 'published' && (
                <a href={`/posts/${post.id}`} target="_blank" rel="noopener noreferrer" className="btn-quiet">
                  View in portal ↗
                </a>
              )}
              {canEdit && post.status === 'pending' && (
                <>
                  <button type="button" className="btn-secondary min-h-[40px]" disabled={busyId === post.id} onClick={() => act(post, 'approve', undefined, 'Approved: it is now in the feed.')}>
                    Approve
                  </button>
                  <button type="button" className="btn-ghost min-h-[40px]" disabled={busyId === post.id} onClick={() => setRejecting(post)}>
                    Reject
                  </button>
                </>
              )}
              {canEdit && (
                <button type="button" className="btn-ghost min-h-[40px]" onClick={() => setEditing(post)}>Edit</button>
              )}
              {canEdit && post.status !== 'published' && post.status !== 'pending' && (
                <button type="button" className="btn-secondary min-h-[40px]" disabled={busyId === post.id} onClick={() => act(post, 'publish', undefined, 'Published to the community feed.')}>
                  Publish
                </button>
              )}
              {canEdit && post.status === 'published' && (
                <>
                  <button type="button" className="btn-ghost min-h-[40px]" disabled={busyId === post.id} onClick={() => setConfirm({ post, action: 'notify' })}>
                    {post.notifiedAt ? 'Emailed ✓' : 'Email members'}
                  </button>
                  <button type="button" className="btn-quiet" disabled={busyId === post.id} onClick={() => act(post, 'unpublish', undefined, 'Moved back to drafts.')}>
                    Unpublish
                  </button>
                </>
              )}
              {canEdit && post.status !== 'archived' && (
                <button type="button" className="btn-quiet" disabled={busyId === post.id} onClick={() => setConfirm({ post, action: 'archive' })}>
                  Archive
                </button>
              )}
              {canEdit && (
                <button type="button" className="btn-quiet text-urgent" disabled={busyId === post.id} onClick={() => setConfirm({ post, action: 'delete' })}>
                  Take down
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {data && <Pagination page={page} limit={data.limit} total={data.total} onPageChange={setPage} />}

      {editing && (
        <PostEditor
          post={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.action === 'notify'
            ? confirm.post.notifiedAt ? 'Members were already emailed' : 'Email members about this post?'
            : confirm?.action === 'archive' ? 'Archive this post?' : 'Take this post down?'
        }
        message={
          confirm?.action === 'notify'
            ? confirm.post.notifiedAt
              ? 'Everyone who was already emailed will not get it again. Only members who joined since then would be emailed.'
              : 'Every active member who has announcement emails turned on will get an email with a link to this post. Emails go out over the next few minutes.'
            : confirm?.action === 'archive'
              ? 'It will be removed from the community feed. You can publish it again later.'
              : 'It will be removed from the feed and from its author’s posts. It stays in Settings > Content history, where you can restore it.'
        }
        confirmLabel={confirm?.action === 'notify' ? 'Send emails' : confirm?.action === 'archive' ? 'Archive' : 'Take down'}
        busy={!!busyId}
        onConfirm={() =>
          confirm &&
          act(confirm.post, confirm.action, undefined, confirm.action === 'archive' ? 'Archived.' : 'Post taken down.')
        }
        onCancel={() => setConfirm(null)}
      />

      {rejecting && (
        <RejectDialog
          post={rejecting}
          busy={busyId === rejecting.id}
          onCancel={() => setRejecting(null)}
          onReject={(note) => act(rejecting, 'reject', { note }, 'Rejected. The author can see your note.')}
        />
      )}

      {rsvpFor && <RsvpList post={rsvpFor} onClose={() => setRsvpFor(null)} />}
    </div>
  );
}

function RejectDialog({ post, busy, onCancel, onReject }: { post: AdminPost; busy: boolean; onCancel: () => void; onReject: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal open title="Reject this post?" onClose={onCancel} width="max-w-md">
      <p className="text-sm text-slate-600">
        “{post.title}” will not appear in the feed. {post.authorName ?? 'The author'} will see it marked “Not approved”, with
        your note, and can edit and resubmit it.
      </p>
      <Field label="Note to the author (optional)">
        <TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn-danger" onClick={() => onReject(note)} disabled={busy}>{busy ? 'Working...' : 'Reject'}</button>
      </div>
    </Modal>
  );
}

function RsvpList({ post, onClose }: { post: AdminPost; onClose: () => void }) {
  const { data, loading } = useApi<{ rsvps: { name: string; accountType: string }[] }>(`/admin/posts/${post.id}`);
  return (
    <Modal open title={`Going: ${post.title}`} onClose={onClose} width="max-w-md">
      {loading && <LoadingBlock label="Loading" />}
      {data && data.rsvps.length === 0 && <p className="text-sm text-slate-500">No one has said they're going yet.</p>}
      <ul className="divide-y divide-slate-100">
        {data?.rsvps.map((r, i) => (
          <li key={i} className="flex items-center justify-between py-2 text-sm">
            <span className="font-semibold text-navy-800">{r.name}</span>
            <span className="text-xs text-slate-500">{humanise(r.accountType ?? '')}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

type EventMode = 'none' | 'linked' | 'own';

function PostEditor({ post, onClose, onSaved }: { post: AdminPost | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(post?.title ?? '');
  const [body, setBody] = useState(post?.body ?? '');
  const [linkUrl, setLinkUrl] = useState(post?.linkUrl ?? '');
  const [mode, setMode] = useState<EventMode>(post?.eventDetails ? 'own' : post?.eventId ? 'linked' : 'none');
  const [eventId, setEventId] = useState(post?.eventId ?? '');
  const [startsAt, setStartsAt] = useState(toDateTimeInput(post?.eventDetails?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toDateTimeInput(post?.eventDetails?.endsAt ?? null));
  const [location, setLocation] = useState(post?.eventDetails?.location ?? '');
  const [rsvpEnabled, setRsvpEnabled] = useState(post?.eventDetails?.rsvpEnabled ?? true);
  const [notify, setNotify] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  // Once created, later saves (e.g. a retry after an image upload error) update the same post.
  const savedId = useRef<string | null>(post?.id ?? null);

  // Only events staff have marked "Show in the community portal" can be linked.
  const { data: events } = useApi<{ events: CrmEvent[] }>('/events?order=desc');
  const eventOptions = (events?.events ?? [])
    .filter((e) => e.communityVisible || e.id === post?.eventId)
    .map((e) => ({ value: e.id, label: e.name, sublabel: formatDate(e.startsAt) }));

  async function save(publish: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title,
        body,
        linkUrl,
        eventId: mode === 'linked' ? eventId || null : null,
        isEvent: mode === 'own',
        eventStartsAt: mode === 'own' && startsAt ? new Date(startsAt).toISOString() : null,
        eventEndsAt: mode === 'own' && endsAt ? new Date(endsAt).toISOString() : null,
        eventLocation: mode === 'own' ? location : null,
        rsvpEnabled: mode === 'own' && rsvpEnabled,
      };
      const saved = savedId.current
        ? (await api.put<{ post: AdminPost }>(`/admin/posts/${savedId.current}`, payload)).post
        : (await api.post<{ post: AdminPost }>('/admin/posts', payload)).post;
      savedId.current = saved.id;
      if (image) {
        const form = new FormData();
        form.set('file', image);
        await api.post(`/admin/posts/${saved.id}/image`, form);
      } else if (removeImage && post?.imageUrl) {
        await api.delete(`/admin/posts/${saved.id}/image`);
      }
      if (publish && saved.status !== 'published') await api.post(`/admin/posts/${saved.id}/publish`);
      if ((publish || saved.status === 'published') && notify) {
        const result = await api.post<{ queued: number }>(`/admin/posts/${saved.id}/notify`);
        toast.success(`Published. Emailing ${result.queued} members over the next few minutes.`);
      } else {
        toast.success(publish ? 'Published to the community feed.' : 'Saved.');
      }
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? { message: caught.message, field: caught.field } : { message: 'Could not save the post.' });
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: string) => (error?.field === field ? error.message : null);
  const isPublished = post?.status === 'published';
  const canNotify = !post?.notifiedAt;

  return (
    <Modal
      open
      title={post ? (post.authorKind === 'member' ? `Edit ${post.authorName ?? 'member'}'s post` : 'Edit post') : 'New post'}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex flex-col gap-3">
          {canNotify && (
            <Checkbox label="Email members about this post when it's published" checked={notify} onChange={setNotify} />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className={isPublished ? 'btn-primary' : 'btn-ghost'} onClick={() => save(false)} disabled={busy}>
              {isPublished ? 'Save changes' : post?.status === 'pending' ? 'Save (keep pending)' : 'Save draft'}
            </button>
            {!isPublished && post?.status !== 'pending' && (
              <button type="button" className="btn-primary" onClick={() => save(true)} disabled={busy}>
                {busy ? 'Saving...' : 'Publish'}
              </button>
            )}
          </div>
        </div>
      }
    >
      <form className="space-y-4" onSubmit={(e) => save(false, e)} noValidate>
        {post?.authorKind === 'member' && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Your edits are logged in Settings &gt; Content history, along with the original text.
          </p>
        )}
        <Field label="Title" required error={errorFor('Title')}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus invalid={!!errorFor('Title')} />
        </Field>
        <Field label="Body" required error={errorFor('Body')} hint="Plain text. Leave a blank line between paragraphs.">
          <MentionTextarea id="admin-post-body" value={body} onChange={setBody} rows={8} maxLength={10000} invalid={!!errorFor('Body')} />
        </Field>
        <Field label="Link" error={errorFor('Link')} hint="Optional. Shown under the post.">
          <TextInput type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" invalid={!!errorFor('Link')} />
        </Field>

        <fieldset>
          <legend className="label">Event</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {([
              ['none', 'Not an event'],
              ['own', 'This post is an event'],
              ['linked', 'Link an ECenter event'],
            ] as const).map(([value, label]) => (
              <label
                key={value}
                className={`chip min-h-[36px] cursor-pointer border px-3 ${mode === value ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white text-slate-600'}`}
              >
                <input type="radio" name="event-mode" className="sr-only" checked={mode === value} onChange={() => setMode(value)} />
                {label}
              </label>
            ))}
          </div>
          {mode === 'own' && (
            <div className="mt-3 space-y-3 rounded-lg border border-slate-200 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Starts" required error={errorFor('Event start')}>
                  <TextInput type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} invalid={!!errorFor('Event start')} />
                </Field>
                <Field label="Ends" error={errorFor('Event end')}>
                  <TextInput type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </Field>
              </div>
              <Field label="Location">
                <TextInput value={location} onChange={(e) => setLocation(e.target.value)} />
              </Field>
              <Checkbox label={'Let members say "I\'ll be there!"'} checked={rsvpEnabled} onChange={setRsvpEnabled} />
              <p className="text-xs text-slate-500">Shows in the feed and in Upcoming events.</p>
            </div>
          )}
          {mode === 'linked' && (
            <div className="mt-3">
              <Field label="ECenter event" error={errorFor('Event')} hint="Only events marked “Show in the community portal” are listed.">
                <Combobox value={eventId} options={eventOptions} placeholder="Search events" onChange={setEventId} />
              </Field>
            </div>
          )}
        </fieldset>

        <div>
          <p className="label">Image</p>
          {post?.imageUrl && !removeImage && !image && (
            <div className="mb-2 flex items-center gap-3">
              <img src={post.imageUrl} alt="" className="h-16 w-28 rounded-lg object-cover" />
              <button type="button" className="btn-quiet" onClick={() => setRemoveImage(true)}>Remove image</button>
            </div>
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setImage(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-[40px] file:rounded-lg file:border-0 file:bg-navy-50 file:px-3 file:font-semibold file:text-navy-700"
            aria-label="Choose an image"
          />
          <p className="mt-1 text-xs text-slate-500">Optional. JPEG, PNG or WebP, up to 5 MB.</p>
          {errorFor('File') && <p className="mt-1 text-xs font-semibold text-urgent">{errorFor('File')}</p>}
        </div>
        {error && !error.field && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">{error.message}</p>
        )}
      </form>
    </Modal>
  );
}
