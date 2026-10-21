import { useState } from 'react';
import { plainText } from '../../components/mentions.tsx';
import { Chip, ErrorBlock, LoadingBlock, SectionHeader } from '../../components/ui.tsx';
import type { Tone } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { PostRevision, RemovedComment } from '../../lib/types.ts';
import { useToast } from '../../state/ToastContext.tsx';

const ACTIONS: Record<PostRevision['action'], { label: string; tone: Tone }> = {
  edit: { label: 'Edited', tone: 'navy' },
  delete: { label: 'Taken down', tone: 'red' },
  restore: { label: 'Restored', tone: 'green' },
  approve: { label: 'Approved', tone: 'green' },
  reject: { label: 'Rejected', tone: 'amber' },
};

/**
 * Settings > Content history: every edit, takedown, restore and review of a
 * community post (with the text as it was BEFORE the change), and every
 * removed comment. Taken-down posts can be restored from here.
 */
export function ContentHistorySection({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [tab, setTab] = useState<'posts' | 'comments'>('posts');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, loading, error, reload } = useApi<{ revisions: PostRevision[]; removedComments: RemovedComment[] }>(
    '/admin/posts/history?limit=100',
  );

  async function restore(postId: string) {
    setBusy(postId);
    try {
      await api.post(`/admin/posts/${postId}/restore`);
      toast.success('Post restored.');
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card p-5">
      <SectionHeader title="Community content history" />
      <p className="-mt-1 mb-3 text-sm text-slate-500">
        Edits, takedowns and approvals of community posts, with the previous version of each, and removed comments.
      </p>
      <div className="mb-3 flex gap-2" role="group" aria-label="History type">
        {(['posts', 'comments'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
            className={`chip min-h-[36px] border px-3 ${tab === value ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white text-slate-600'}`}
          >
            {value === 'posts' ? `Post changes (${data?.revisions.length ?? 0})` : `Removed comments (${data?.removedComments.length ?? 0})`}
          </button>
        ))}
      </div>

      {loading && !data && <LoadingBlock label="Loading history" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {data && tab === 'posts' && (
        data.revisions.length === 0 ? (
          <p className="text-sm text-slate-500">No post changes yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.revisions.map((rev) => (
              <li key={rev.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Chip tone={ACTIONS[rev.action].tone}>{ACTIONS[rev.action].label}</Chip>
                  <span className="font-semibold text-navy-800">{rev.currentTitle ?? rev.previous.title}</span>
                  {rev.postDeleted && <Chip tone="red">Currently taken down</Chip>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {rev.changedByName ?? 'Someone'} · {formatDateTime(rev.createdAt)}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-quiet text-xs"
                    aria-expanded={open === rev.id}
                    onClick={() => setOpen(open === rev.id ? null : rev.id)}
                  >
                    {open === rev.id ? 'Hide previous version' : 'Show previous version'}
                  </button>
                  {canEdit && rev.postDeleted && rev.action === 'delete' && (
                    <button type="button" className="btn-quiet text-xs font-semibold text-teal-700" disabled={busy === rev.postId} onClick={() => restore(rev.postId)}>
                      Restore post
                    </button>
                  )}
                </div>
                {open === rev.id && (
                  <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      Before this change ({rev.previous.status})
                    </p>
                    <p className="mt-1 font-semibold text-navy-800">{rev.previous.title}</p>
                    <p className="mt-1 whitespace-pre-line text-slate-700">{plainText(rev.previous.body)}</p>
                    {rev.previous.linkUrl && <p className="mt-1 break-all text-xs text-slate-500">Link: {rev.previous.linkUrl}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )
      )}

      {data && tab === 'comments' && (
        data.removedComments.length === 0 ? (
          <p className="text-sm text-slate-500">No comments have been removed.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.removedComments.map((comment) => (
              <li key={comment.id} className="py-3 text-sm">
                <p className="text-slate-700">“{plainText(comment.body)}”</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  By {comment.authorName ?? 'a member'} on “{comment.postTitle}” · removed by {comment.removedByName ?? 'someone'}{' '}
                  {formatDateTime(comment.removedAt)}
                </p>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
