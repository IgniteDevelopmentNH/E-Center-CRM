import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RichText } from '../../components/mentions.tsx';
import { CommentsSection, DateBadge, LikeButton, MemberPostEditor, PostAuthor, PostBadges, RsvpButton, eventWhen } from '../../components/posts.tsx';
import { ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { useApi, useCommunityBase } from '../../lib/hooks.ts';
import type { FeedPost, PostComment } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

const STATUS_NOTES: Record<string, string> = {
  pending: 'Waiting for ECenter approval. Only you and staff can see this post.',
  rejected: 'Not approved by the ECenter. Only you and staff can see this post.',
  draft: 'Draft. Only staff can see this post.',
  archived: 'Archived. It no longer appears in the feed.',
};

export function PostDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, community, isStaff } = useAuth();
  const base = useCommunityBase();
  const { data, loading, error, reload } = useApi<{ post: FeedPost; comments: PostComment[] }>(id ? `${base}/posts/${id}` : null);
  const [post, setPost] = useState<FeedPost | null>(null);
  const [comments, setComments] = useState<PostComment[]>([]);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (data) {
      setPost(data.post);
      setComments(data.comments);
    }
  }, [data]);

  useEffect(() => {
    if (post && window.location.hash === '#comments') {
      document.getElementById('comments')?.scrollIntoView({ block: 'start' });
    }
  }, [post?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !post) return <LoadingBlock label="Loading post" />;
  if (error || !post) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <ErrorBlock message={error ?? 'That post is not available.'} onRetry={reload} />
        <Link to="/" className="btn-ghost">Back to the feed</Link>
      </div>
    );
  }

  const patch = (change: Partial<FeedPost>) => setPost((current) => (current ? { ...current, ...change } : current));
  const isMine = !!community && post.author.kind === 'member' && post.author.id === community.userId;

  async function remove() {
    if (!post || !window.confirm('Take this post down? It will disappear from the feed.')) return;
    try {
      await api.delete(`/community/posts/${post.id}`);
      toast.success('Post removed.');
      navigate(isMine ? '/my-posts' : '/', { replace: true });
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 sm:space-y-5">
      <Link to="/" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-teal-700 hover:underline">
        <span aria-hidden="true">←</span>&nbsp;Feed
      </Link>

      {STATUS_NOTES[post.status] && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          {STATUS_NOTES[post.status]}
          {post.reviewNote && <span className="mt-1 block">Note from the ECenter: “{post.reviewNote}”</span>}
        </div>
      )}

      <article className="card overflow-hidden" aria-labelledby="post-title">
        <div className="p-4 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <PostAuthor post={post} />
            {(post.canEdit || post.canDelete) && (
              <div className="flex shrink-0 gap-1">
                {post.canEdit && isMine && community && community.postPermission !== 'none' && (
                  <button type="button" className="btn-quiet" onClick={() => setEditing(true)}>Edit</button>
                )}
                {post.canEdit && !isMine && isStaff && (
                  <Link to="/admin/posts" className="btn-quiet">Edit in admin</Link>
                )}
                {post.canDelete && (
                  <button type="button" className="btn-quiet text-urgent" onClick={remove}>Take down</button>
                )}
              </div>
            )}
          </div>
          <PostBadges post={post} />
          <h1 id="post-title" className="mt-4 text-2xl font-bold text-navy-800">{post.title}</h1>
          <RichText text={post.body} className="mt-3 text-[15px] leading-relaxed text-slate-700" />
        </div>

        {post.imageUrl && <img src={post.imageUrl} alt="" className="w-full border-y border-slate-100 object-cover" />}

        {post.event && (
          <section className="space-y-3 border-t border-slate-100 p-4 sm:p-6" aria-label="Event details">
            <div className="flex items-center gap-3">
              <DateBadge iso={post.event.startsAt} size="lg" />
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Event</p>
                <p className="font-semibold text-navy-800">{eventWhen(post.event.startsAt, post.event.endsAt)}</p>
                {post.event.location && <p className="text-sm text-slate-600">{post.event.location}</p>}
              </div>
            </div>
            {post.event.rsvpEnabled && post.status === 'published' && (
              <RsvpButton
                target="post"
                id={post.id}
                going={post.event.going}
                count={post.event.rsvpCount}
                age21={post.event.age21}
                showAttendees={post.event.attendeesPublic || post.canEdit}
                onChange={(state) => patch({ event: { ...post.event!, going: state.going, rsvpCount: state.rsvpCount } })}
              />
            )}
          </section>
        )}

        {post.linkedEvent && (
          <div className="border-t border-slate-100 p-4 sm:px-6">
            <Link to={`/events/${post.linkedEvent.id}`} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 hover:border-teal-200">
              <DateBadge iso={post.linkedEvent.startsAt} />
              <span className="min-w-0">
                <span className="block font-semibold text-navy-800">{post.linkedEvent.name}</span>
                <span className="block text-xs text-slate-500">{eventWhen(post.linkedEvent.startsAt, post.linkedEvent.endsAt)}</span>
              </span>
            </Link>
          </div>
        )}

        {post.linkUrl && (
          <div className="border-t border-slate-100 px-4 py-3 sm:px-6">
            <a href={post.linkUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-teal-700 hover:underline break-all">
              {post.linkUrl} <span aria-hidden="true">↗</span>
            </a>
          </div>
        )}

        {post.status === 'published' && (
          <footer className="flex items-center gap-1 border-t border-slate-100 px-2 py-1 sm:px-4">
            <LikeButton post={post} onChange={patch} />
          </footer>
        )}
      </article>

      {post.status === 'published' && !user && (
        <section className="card p-4 sm:p-6" aria-label="Comments">
          <h2 className="text-sm font-bold uppercase tracking-wide text-navy-800">
            Comments {post.commentCount > 0 && <span className="text-slate-400">({post.commentCount})</span>}
          </h2>
          <p className="mt-3 text-sm text-slate-600">
            <Link to={`/login?next=${encodeURIComponent(`/posts/${post.id}`)}`} className="font-semibold text-teal-700 hover:underline">Sign in</Link> or{' '}
            <Link to="/signup" className="font-semibold text-teal-700 hover:underline">create an account</Link> to read and join the conversation.
          </p>
        </section>
      )}

      {post.status === 'published' && !!user && (
        <CommentsSection
          postId={post.id}
          comments={comments}
          onComments={setComments}
          onCountChange={(commentCount) => patch({ commentCount })}
        />
      )}

      {editing && community && (
        <MemberPostEditor
          post={post}
          needsApproval={community.postPermission === 'approval'}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setPost(saved);
          }}
        />
      )}
    </div>
  );
}
