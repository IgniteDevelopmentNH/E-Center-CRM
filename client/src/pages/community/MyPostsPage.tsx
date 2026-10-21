import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { plainText } from '../../components/mentions.tsx';
import { MemberPostEditor } from '../../components/posts.tsx';
import { Chip, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import type { Tone } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { formatRelative, truncate } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { FeedPost } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

const STATUS: Record<FeedPost['status'], { label: string; tone: Tone }> = {
  published: { label: 'Published', tone: 'green' },
  pending: { label: 'Awaiting approval', tone: 'amber' },
  rejected: { label: 'Not approved', tone: 'red' },
  draft: { label: 'Draft', tone: 'slate' },
  archived: { label: 'Archived', tone: 'slate' },
};

/** A member's own posts (shown in the nav only for people allowed to post). */
export function MyPostsPage() {
  const { community } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ posts: FeedPost[] }>('/community/my-posts');
  const [editing, setEditing] = useState<FeedPost | 'new' | null>(null);

  if (!community) return <Navigate to="/profile" replace />;
  const canPost = community.postPermission !== 'none';
  const needsApproval = community.postPermission === 'approval';

  async function remove(post: FeedPost) {
    if (!window.confirm(`Take down "${post.title}"? It will disappear from the feed.`)) return;
    try {
      await api.delete(`/community/posts/${post.id}`);
      setData((current) => (current ? { posts: current.posts.filter((p) => p.id !== post.id) } : current));
      toast.success('Post removed.');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">My posts</h1>
          <p className="mt-1 text-sm text-slate-500">
            {!canPost
              ? 'Your account cannot create new posts right now. You can still take down existing ones.'
              : needsApproval
                ? 'The ECenter approves posts before they appear in the feed.'
                : 'Your posts appear in the feed as soon as you share them.'}
          </p>
        </div>
        {canPost && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>+ New post</button>
        )}
      </header>

      {loading && !data && <LoadingBlock label="Loading your posts" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.posts.length === 0 && (
        <EmptyState
          title="You haven't posted yet"
          message="Share news, an opportunity, or an event with the community."
          icon="▤"
          action={canPost ? <button type="button" className="btn-primary" onClick={() => setEditing('new')}>Write a post</button> : undefined}
        />
      )}

      <ul className="space-y-3">
        {data?.posts.map((post) => (
          <li key={post.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={STATUS[post.status].tone}>{STATUS[post.status].label}</Chip>
              {post.event && <Chip tone="teal">Event</Chip>}
              <span className="text-xs text-slate-400">Updated {formatRelative(post.updatedAt)}</span>
            </div>
            <Link to={`/posts/${post.id}`} className="mt-2 block text-base font-bold text-navy-800 hover:underline">
              {post.title}
            </Link>
            <p className="mt-1 text-sm text-slate-600">{truncate(plainText(post.body), 160)}</p>
            {post.status === 'rejected' && post.reviewNote && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-urgent">Note from the ECenter: “{post.reviewNote}”</p>
            )}
            {post.status === 'published' && (
              <p className="mt-2 text-xs text-slate-500">
                {post.likeCount} {post.likeCount === 1 ? 'like' : 'likes'} · {post.commentCount}{' '}
                {post.commentCount === 1 ? 'comment' : 'comments'}
                {post.event?.rsvpEnabled ? ` · ${post.event.rsvpCount} going` : ''}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {canPost && post.status !== 'archived' && (
                <button type="button" className="btn-ghost min-h-[40px]" onClick={() => setEditing(post)}>Edit</button>
              )}
              <button type="button" className="btn-quiet text-urgent" onClick={() => remove(post)}>Take down</button>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <MemberPostEditor
          post={editing === 'new' ? null : editing}
          needsApproval={needsApproval}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
