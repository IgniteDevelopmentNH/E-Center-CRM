import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ConfirmDialog, Modal } from '../../components/overlays.tsx';
import { Chip, EmptyState, ErrorBlock, Field, LoadingBlock, Pagination, Select, TextArea, TextInput } from '../../components/ui.tsx';
import type { Tone } from '../../components/ui.tsx';
import { ApiError, api, buildQuery } from '../../lib/api.ts';
import { formatDate, formatDateTime, truncate } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { AdminPost, CrmEvent } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

const STATUS_TONES: Record<AdminPost['status'], Tone> = { draft: 'amber', published: 'green', archived: 'slate' };
const FILTERS = [
  { value: 'all', label: 'All posts' },
  { value: 'draft', label: 'Drafts' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
];

/** Admin-authored community feed. Owners/editors write; viewers read. */
export function PostsAdminPage() {
  const { canEdit } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminPost | 'new' | null>(null);
  const [archiving, setArchiving] = useState<AdminPost | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, loading, error, reload } = useApi<{ posts: AdminPost[]; total: number; limit: number }>(
    `/admin/posts${buildQuery({ status, page, limit: 20 })}`,
  );

  async function transition(post: AdminPost, action: 'publish' | 'unpublish' | 'archive') {
    setBusyId(post.id);
    try {
      await api.post(`/admin/posts/${post.id}/${action}`);
      toast.success(action === 'publish' ? 'Published to the community feed.' : action === 'unpublish' ? 'Moved back to drafts.' : 'Archived.');
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusyId(null);
      setArchiving(null);
    }
  }

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Posts</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            News and announcements for the community feed. Only published posts are visible to students and mentors.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            + New post
          </button>
        )}
      </header>

      <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Filter posts">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={status === filter.value}
            onClick={() => {
              setStatus(filter.value);
              setPage(1);
            }}
            className={`chip min-h-[36px] border px-3 ${
              status === filter.value ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-navy-200'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loading && !data && <LoadingBlock label="Loading posts" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.posts.length === 0 && (
        <EmptyState
          title="No posts here yet"
          message="Write a post to share news, programs and events with students and mentors."
          icon="▤"
          action={canEdit ? <button type="button" className="btn-primary" onClick={() => setEditing('new')}>Write the first post</button> : undefined}
        />
      )}

      <ul className="space-y-3">
        {data?.posts.map((post) => (
          <li key={post.id} className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
            {post.imageUrl && <img src={post.imageUrl} alt="" className="h-20 w-full rounded-lg object-cover sm:w-32" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={STATUS_TONES[post.status]}>{post.status === 'draft' ? 'Draft' : post.status === 'published' ? 'Published' : 'Archived'}</Chip>
                <h2 className="font-bold text-navy-800">{post.title}</h2>
              </div>
              <p className="mt-1 text-sm text-slate-600">{truncate(post.body, 180)}</p>
              <p className="mt-1 text-xs text-slate-400">
                {post.publishedAt ? `Published ${formatDateTime(post.publishedAt)}` : `Last edited ${formatDateTime(post.updatedAt)}`}
                {post.authorName ? ` · by ${post.authorName}` : ''}
                {post.eventName ? ` · Event: ${post.eventName}` : ''}
              </p>
            </div>
            {canEdit && (
              <div className="flex shrink-0 flex-wrap gap-2">
                <button type="button" className="btn-ghost min-h-[40px]" onClick={() => setEditing(post)}>Edit</button>
                {post.status !== 'published' ? (
                  <button type="button" className="btn-secondary min-h-[40px]" onClick={() => transition(post, 'publish')} disabled={busyId === post.id}>
                    Publish
                  </button>
                ) : (
                  <button type="button" className="btn-ghost min-h-[40px]" onClick={() => transition(post, 'unpublish')} disabled={busyId === post.id}>
                    Unpublish
                  </button>
                )}
                {post.status !== 'archived' && (
                  <button type="button" className="btn-quiet" onClick={() => setArchiving(post)} disabled={busyId === post.id}>
                    Archive
                  </button>
                )}
              </div>
            )}
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
        open={!!archiving}
        title="Archive this post?"
        message="It will be removed from the community feed. You can publish it again later."
        confirmLabel="Archive"
        busy={!!busyId}
        onConfirm={() => archiving && transition(archiving, 'archive')}
        onCancel={() => setArchiving(null)}
      />
    </div>
  );
}

function PostEditor({ post, onClose, onSaved }: { post: AdminPost | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(post?.title ?? '');
  const [body, setBody] = useState(post?.body ?? '');
  const [linkUrl, setLinkUrl] = useState(post?.linkUrl ?? '');
  const [eventId, setEventId] = useState(post?.eventId ?? '');
  const [image, setImage] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  // Once created, later saves (e.g. a retry after an image upload error) update the same post.
  const [savedId, setSavedId] = useState<string | null>(post?.id ?? null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Only events staff have marked "Show in the community portal" can be attached.
  const { data: events } = useApi<{ events: CrmEvent[] }>('/events?order=desc');
  const eventOptions = [
    { value: '', label: 'No event' },
    ...(events?.events ?? [])
      .filter((e) => e.communityVisible || e.id === post?.eventId)
      .map((e) => ({ value: e.id, label: `${e.name} (${formatDate(e.startsAt)})` })),
  ];

  async function save(publish: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { title, body, linkUrl, eventId: eventId || null };
      const saved = savedId
        ? (await api.put<{ post: AdminPost }>(`/admin/posts/${savedId}`, payload)).post
        : (await api.post<{ post: AdminPost }>('/admin/posts', payload)).post;
      setSavedId(saved.id);
      if (image) {
        const form = new FormData();
        form.set('file', image);
        await api.post(`/admin/posts/${saved.id}/image`, form);
      } else if (removeImage && post?.imageUrl) {
        await api.delete(`/admin/posts/${saved.id}/image`);
      }
      if (publish && saved.status !== 'published') await api.post(`/admin/posts/${saved.id}/publish`);
      toast.success(publish ? 'Published to the community feed.' : 'Saved.');
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? { message: caught.message, field: caught.field } : { message: 'Could not save the post.' });
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: string) => (error?.field === field ? error.message : null);
  const isPublished = post?.status === 'published';

  return (
    <Modal
      open
      title={post ? 'Edit post' : 'New post'}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={isPublished ? 'btn-primary' : 'btn-ghost'} onClick={() => save(false)} disabled={busy}>
            {isPublished ? 'Save changes' : 'Save draft'}
          </button>
          {!isPublished && (
            <button type="button" className="btn-primary" onClick={() => save(true)} disabled={busy}>
              {busy ? 'Saving...' : 'Publish'}
            </button>
          )}
        </div>
      }
    >
      <form className="space-y-4" onSubmit={(e) => save(false, e)} noValidate>
        <Field label="Title" required error={errorFor('Title')}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus invalid={!!errorFor('Title')} />
        </Field>
        <Field label="Body" required error={errorFor('Body')} hint="Plain text. Leave a blank line between paragraphs.">
          <TextArea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={10000} invalid={!!errorFor('Body')} />
        </Field>
        <Field label="Link" error={errorFor('Link')} hint="Optional. Shown under the post.">
          <TextInput type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" invalid={!!errorFor('Link')} />
        </Field>
        <Field label="Related event" error={errorFor('Event')} hint="Only events marked “Show in the community portal” are listed.">
          <Select value={eventId} options={eventOptions} onChange={(e) => setEventId(e.target.value)} />
        </Field>
        <div>
          <p className="label">Image</p>
          {post?.imageUrl && !removeImage && !image && (
            <div className="mb-2 flex items-center gap-3">
              <img src={post.imageUrl} alt="" className="h-16 w-28 rounded-lg object-cover" />
              <button type="button" className="btn-quiet" onClick={() => setRemoveImage(true)}>Remove image</button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setImage(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-50 file:px-3 file:py-2 file:font-semibold file:text-navy-700"
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
