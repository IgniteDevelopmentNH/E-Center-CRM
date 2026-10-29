import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../lib/api.ts';
import { formatDate, formatRelative, formatTime, toDateTimeInput } from '../lib/format.ts';
import type { FeedPost, PostComment } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';
import { MemberAvatar, accountTypeLabel } from './community.tsx';
import { Age21Badge, AttendeesButton, AudienceField, EventOptionFields, GuestVisibilityField } from './eventOptions.tsx';
import { MentionTextarea, RichText } from './mentions.tsx';
import { Modal } from './overlays.tsx';
import { Checkbox, Field, TextInput } from './ui.tsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function DateBadge({ iso, size = 'md' }: { iso: string; size?: 'md' | 'lg' }) {
  const date = new Date(iso);
  return (
    <span
      className={`flex shrink-0 flex-col items-center justify-center rounded-lg bg-navy-50 text-navy-700 ${
        size === 'lg' ? 'h-16 w-16' : 'h-12 w-12'
      }`}
      aria-hidden="true"
    >
      <span className="text-[10px] font-bold uppercase tracking-wide">{MONTHS[date.getMonth()]}</span>
      <span className={`font-bold leading-none ${size === 'lg' ? 'text-2xl' : 'text-lg'}`}>{date.getDate()}</span>
    </span>
  );
}

export function eventWhen(startsAt: string, endsAt: string | null): string {
  const start = `${formatDate(startsAt)} · ${formatTime(startsAt)}`;
  if (!endsAt) return start;
  const sameDay = new Date(startsAt).toDateString() === new Date(endsAt).toDateString();
  return sameDay ? `${start}–${formatTime(endsAt)}` : `${start} – ${formatDate(endsAt)} ${formatTime(endsAt)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------- author -- */

export function PostAuthor({ post }: { post: FeedPost }) {
  const { author } = post;
  const avatar =
    author.kind === 'member' ? (
      <MemberAvatar name={author.name} photoUrl={author.photoUrl} size="sm" />
    ) : (
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-navy text-[10px] font-bold text-white" aria-hidden="true">
        UNH
      </span>
    );
  const name = <span className="truncate text-sm font-semibold text-navy-800">{author.name}</span>;
  return (
    <header className="flex items-center gap-3">
      {author.id ? <Link to={`/members/${author.id}`} tabIndex={-1} aria-hidden="true">{avatar}</Link> : avatar}
      <div className="min-w-0">
        {author.id ? (
          <Link to={`/members/${author.id}`} className="block truncate hover:underline">
            {name}
          </Link>
        ) : (
          <p className="truncate">{name}</p>
        )}
        <p className="text-xs text-slate-500">
          {post.publishedAt ? (
            <time dateTime={post.publishedAt} title={`${formatDate(post.publishedAt)} at ${formatTime(post.publishedAt)}`}>
              {formatRelative(post.publishedAt)}
            </time>
          ) : (
            'Not published'
          )}
          {' · '}
          {author.kind === 'member' ? accountTypeLabel(author.accountType) : 'UNH ECenter'}
        </p>
      </div>
    </header>
  );
}

/* ------------------------------------------------------ interactions -- */

export function LikeButton({ post, onChange }: { post: FeedPost; onChange: (patch: Partial<FeedPost>) => void }) {
  const { isActiveMember } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!isActiveMember) {
    return (
      <span className="inline-flex min-h-[44px] items-center gap-1.5 px-2 text-sm text-slate-500">
        <span aria-hidden="true">♡</span> {post.likeCount}
      </span>
    );
  }
  async function toggle() {
    const next = !post.likedByMe;
    onChange({ likedByMe: next, likeCount: post.likeCount + (next ? 1 : -1) });
    setBusy(true);
    try {
      const result = await api.post<{ likeCount: number; likedByMe: boolean }>(`/community/posts/${post.id}/like`, { liked: next });
      onChange(result);
    } catch (caught) {
      onChange({ likedByMe: post.likedByMe, likeCount: post.likeCount });
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={post.likedByMe}
      aria-label={post.likedByMe ? `Unlike (${post.likeCount} likes)` : `Like (${post.likeCount} likes)`}
      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition hover:bg-slate-100 ${
        post.likedByMe ? 'text-urgent' : 'text-slate-600'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill={post.likedByMe ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z" />
      </svg>
      {post.likeCount > 0 ? post.likeCount : 'Like'}
    </button>
  );
}

/** "I'll be there!" toggle for an event post or a community CRM event. */
export function RsvpButton({
  target,
  id,
  going,
  count,
  age21 = false,
  showAttendees = false,
  onChange,
}: {
  target: 'post' | 'event';
  id: string;
  going: boolean;
  count: number;
  /** 21+ event: saying "I'll be there!" asks the person to confirm they are over 21. */
  age21?: boolean;
  /** The organiser shared the list (or the viewer organised it / is staff). */
  showAttendees?: boolean;
  onChange: (state: { going: boolean; rsvpCount: number }) => void;
}) {
  const { user, isActiveMember } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [over21, setOver21] = useState(false);

  async function send(next: boolean) {
    setBusy(true);
    try {
      onChange(
        await api.post<{ going: boolean; rsvpCount: number }>(`/community/${target === 'post' ? 'posts' : 'events'}/${id}/rsvp`, {
          going: next,
          over21: next && age21 ? true : undefined,
        }),
      );
      setConfirming(false);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    if (!going && age21) {
      setOver21(false);
      setConfirming(true);
      return;
    }
    void send(!going);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {isActiveMember && (
        <button type="button" onClick={toggle} disabled={busy} aria-pressed={going} className={going ? 'btn-secondary' : 'btn-primary'}>
          {going ? "✓ You're going" : "I'll be there!"}
        </button>
      )}
      {!user && (
        <Link to="/login" className="btn-primary">
          Sign in to RSVP
        </Link>
      )}
      {age21 && <Age21Badge />}
      <span className="text-sm text-slate-600" aria-live="polite">
        {count === 0 ? 'Be the first to say you’re going' : `${count} ${count === 1 ? 'person' : 'people'} going`}
      </span>
      {showAttendees && !!user && <AttendeesButton target={target} id={id} count={count} />}
      {going && (
        <span className="w-full text-xs text-slate-500">Changed your mind? Tap the button again to remove your RSVP.</span>
      )}
      <Modal
        open={confirming}
        title="This is a 21+ event"
        onClose={() => setConfirming(false)}
        width="max-w-md"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn-primary" onClick={() => send(true)} disabled={busy || !over21}>
              {busy ? 'Saving...' : "I'll be there!"}
            </button>
          </div>
        }
      >
        <p className="text-sm text-slate-600">The organiser has marked this event 21 and over.</p>
        <div className="mt-3">
          <Checkbox label="I'm over 21" checked={over21} onChange={setOver21} />
        </div>
      </Modal>
    </div>
  );
}

/** Group and 21+ markers shown on a post. */
export function PostBadges({ post }: { post: FeedPost }) {
  if (!post.groups.length && !post.event?.age21) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {post.event?.age21 && <Age21Badge />}
      {post.groups.map((group) => (
        <Link key={group.id} to={`/groups/${group.slug}`} className="chip bg-teal-50 text-teal-800 hover:underline">
          {group.name}
        </Link>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- card -- */

const LONG_POST = 420;

export function PostCard({ post, onChange }: { post: FeedPost; onChange: (patch: Partial<FeedPost>) => void }) {
  const long = post.body.length > LONG_POST;
  return (
    <article className="card overflow-hidden" aria-labelledby={`post-${post.id}`}>
      <div className="p-4 sm:p-6">
        <PostAuthor post={post} />
        <PostBadges post={post} />
        <h2 id={`post-${post.id}`} className="mt-3 text-lg font-bold text-navy-800 sm:text-xl">
          <Link to={`/posts/${post.id}`} className="hover:underline">
            {post.title}
          </Link>
        </h2>
        <div className={long ? 'relative max-h-48 overflow-hidden' : ''}>
          <RichText text={post.body} className="mt-2 text-[15px] leading-relaxed text-slate-700" />
          {long && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white" aria-hidden="true" />}
        </div>
        {long && (
          <Link to={`/posts/${post.id}`} className="mt-1 inline-block text-sm font-semibold text-teal-700 hover:underline">
            Read more
          </Link>
        )}
      </div>

      {post.imageUrl && (
        <Link to={`/posts/${post.id}`} tabIndex={-1} aria-hidden="true">
          <img src={post.imageUrl} alt="" className="max-h-[420px] w-full border-y border-slate-100 object-cover" loading="lazy" />
        </Link>
      )}

      {(post.event || post.linkedEvent || post.linkUrl) && (
        <div className="space-y-3 px-4 pt-4 sm:px-6">
          {post.event && (
            <Link to={`/posts/${post.id}`} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 hover:border-teal-200">
              <DateBadge iso={post.event.startsAt} />
              <span className="min-w-0">
                <span className="block text-xs font-bold uppercase tracking-wide text-teal-700">Event</span>
                <span className="block truncate text-sm text-slate-700">{eventWhen(post.event.startsAt, post.event.endsAt)}</span>
                {post.event.location && <span className="block truncate text-xs text-slate-500">{post.event.location}</span>}
                {post.event.rsvpEnabled && (
                  <span className="mt-0.5 block text-xs font-semibold text-teal-700">
                    {post.event.going ? "✓ You're going" : `${post.event.rsvpCount} going · View details`}
                  </span>
                )}
              </span>
            </Link>
          )}
          {post.linkedEvent && (
            <Link to={`/events/${post.linkedEvent.id}`} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 hover:border-teal-200">
              <DateBadge iso={post.linkedEvent.startsAt} />
              <span className="min-w-0">
                <span className="block text-xs font-bold uppercase tracking-wide text-teal-700">Event</span>
                <span className="block truncate font-semibold text-navy-800">{post.linkedEvent.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {eventWhen(post.linkedEvent.startsAt, post.linkedEvent.endsAt)}
                  {post.linkedEvent.location ? ` · ${post.linkedEvent.location}` : ''}
                </span>
              </span>
            </Link>
          )}
          {post.linkUrl && (
            <a href={post.linkUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-teal-700 hover:underline">
              {hostOf(post.linkUrl)} <span aria-hidden="true">↗</span>
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </div>
      )}

      <footer className="mt-2 flex items-center gap-1 border-t border-slate-100 px-2 py-1 sm:px-4">
        <LikeButton post={post} onChange={onChange} />
        <Link
          to={`/posts/${post.id}#comments`}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-100"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z" />
          </svg>
          {post.commentCount > 0 ? `${post.commentCount} ${post.commentCount === 1 ? 'comment' : 'comments'}` : 'Comment'}
        </Link>
      </footer>
    </article>
  );
}

/* ----------------------------------------------------------- comments -- */

export function CommentsSection({
  postId,
  comments,
  onComments,
  onCountChange,
}: {
  postId: string;
  comments: PostComment[];
  onComments: (comments: PostComment[]) => void;
  onCountChange: (count: number) => void;
}) {
  const { user, isActiveMember, isStaff } = useAuth();
  const toast = useToast();
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);

  const count = (list: PostComment[]) => list.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0);

  async function remove(comment: PostComment) {
    if (!window.confirm('Remove this comment?')) return;
    try {
      await api.delete(`/community/comments/${comment.id}`);
      const next = comments
        .filter((c) => c.id !== comment.id)
        .map((c) => ({ ...c, replies: (c.replies ?? []).filter((r) => r.id !== comment.id) }));
      onComments(next);
      onCountChange(count(next));
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  function renderComment(comment: PostComment, isReply: boolean) {
    return (
      <li key={comment.id} className={isReply ? 'mt-3' : ''}>
        <div className="flex gap-3">
          {comment.author.id ? (
            <Link to={`/members/${comment.author.id}`} tabIndex={-1} aria-hidden="true">
              <MemberAvatar name={comment.author.name} photoUrl={comment.author.photoUrl} size="sm" />
            </Link>
          ) : (
            <MemberAvatar name={comment.author.name} photoUrl={null} size="sm" />
          )}
          <div className="min-w-0 flex-1">
            <div className="rounded-2xl bg-slate-50 px-3 py-2">
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                {comment.author.id ? (
                  <Link to={`/members/${comment.author.id}`} className="font-semibold text-navy-800 hover:underline">
                    {comment.author.name}
                  </Link>
                ) : (
                  <span className="font-semibold text-navy-800">{comment.author.name}</span>
                )}
                {comment.author.isPostAuthor && <span className="chip bg-teal-50 text-teal-800">Author</span>}
              </p>
              <RichText text={comment.body} className="text-sm text-slate-700" />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-slate-500">
              <time dateTime={comment.createdAt} className="px-1">{formatRelative(comment.createdAt)}</time>
              {isActiveMember && (
                <button type="button" className="btn-quiet min-h-[36px] text-xs font-semibold" onClick={() => setReplyTo(isReply ? comments.find((c) => c.id === comment.parentId) ?? comment : comment)}>
                  Reply
                </button>
              )}
              {comment.canDelete && (
                <button type="button" className="btn-quiet min-h-[36px] text-xs text-urgent" onClick={() => remove(comment)}>
                  Remove
                </button>
              )}
            </div>
            {!isReply && comment.replies && comment.replies.length > 0 && (
              <ul className="mt-1 border-l-2 border-slate-100 pl-3">{comment.replies.map((r) => renderComment(r, true))}</ul>
            )}
          </div>
        </div>
      </li>
    );
  }

  return (
    <section id="comments" className="card p-4 sm:p-6" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="text-sm font-bold uppercase tracking-wide text-navy-800">
        Comments {count(comments) > 0 && <span className="text-slate-400">({count(comments)})</span>}
      </h2>
      {comments.length === 0 && <p className="mt-3 text-sm text-slate-500">No comments yet.</p>}
      <ul className="mt-4 space-y-4">{comments.map((c) => renderComment(c, false))}</ul>

      {isActiveMember ? (
        <CommentComposer
          postId={postId}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onPosted={(next) => {
            onComments(next);
            onCountChange(count(next));
            setReplyTo(null);
          }}
        />
      ) : (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {!user ? (
            <>
              <Link to="/login" className="font-semibold text-teal-700 hover:underline">Sign in</Link> or{' '}
              <Link to="/signup" className="font-semibold text-teal-700 hover:underline">create an account</Link> to read and write comments.
            </>
          ) : isStaff ? (
            <>
              <Link to="/profile" className="font-semibold text-teal-700 hover:underline">Create your community profile</Link> to comment. You can still remove comments as staff.
            </>
          ) : (
            'Finish setting up your account to comment.'
          )}
        </p>
      )}
    </section>
  );
}

function CommentComposer({
  postId,
  replyTo,
  onCancelReply,
  onPosted,
}: {
  postId: string;
  replyTo: PostComment | null;
  onCancelReply: () => void;
  onPosted: (comments: PostComment[]) => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ comments: PostComment[] }>(`/community/posts/${postId}/comments`, {
        body,
        parentId: replyTo?.id ?? null,
      });
      setBody('');
      onPosted(response.comments);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Your comment was not posted. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-2 border-t border-slate-100 pt-4">
      {replyTo && (
        <p className="flex items-center gap-2 text-xs text-slate-500">
          Replying to <span className="font-semibold text-navy-800">{replyTo.author.name}</span>
          <button type="button" className="btn-quiet min-h-[32px] text-xs" onClick={onCancelReply}>Cancel</button>
        </p>
      )}
      <label htmlFor="comment-body" className="sr-only">Write a comment</label>
      <MentionTextarea id="comment-body" value={body} onChange={setBody} rows={2} maxLength={2000} placeholder="Write a comment" />
      {error && <p className="text-sm font-semibold text-urgent" role="alert">{error}</p>}
      <div className="flex justify-end">
        <button type="submit" className="btn-secondary" disabled={busy || !body.trim()}>
          {busy ? 'Posting...' : replyTo ? 'Reply' : 'Comment'}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- editor -- */

/** Create or edit a member's own post (title, body with @mentions, link, image, optional event). */
export function MemberPostEditor({
  post,
  needsApproval,
  onClose,
  onSaved,
  defaultAudience = 'everyone',
  defaultGroupIds = [],
}: {
  post: FeedPost | null;
  needsApproval: boolean;
  onClose: () => void;
  onSaved: (post: FeedPost) => void;
  /** Opened from a group page: start as a post to that group. */
  defaultAudience?: 'everyone' | 'groups';
  defaultGroupIds?: string[];
}) {
  const toast = useToast();
  const [title, setTitle] = useState(post?.title ?? '');
  const [body, setBody] = useState(post?.body ?? '');
  const [linkUrl, setLinkUrl] = useState(post?.linkUrl ?? '');
  const [isEvent, setIsEvent] = useState(!!post?.event);
  const [startsAt, setStartsAt] = useState(toDateTimeInput(post?.event?.startsAt ?? null));
  const [location, setLocation] = useState(post?.event?.location ?? '');
  const [rsvpEnabled, setRsvpEnabled] = useState(post?.event?.rsvpEnabled ?? true);
  const [age21, setAge21] = useState(post?.event?.age21 ?? false);
  const [attendeesPublic, setAttendeesPublic] = useState(post?.event?.attendeesPublic ?? false);
  const [guestVisible, setGuestVisible] = useState(post?.guestVisible ?? true);
  const [audience, setAudience] = useState<'everyone' | 'groups'>(post?.audience ?? defaultAudience);
  const [groupIds, setGroupIds] = useState<string[]>(post?.groups.map((g) => g.id) ?? defaultGroupIds);
  const [image, setImage] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const savedId = useRef<string | null>(post?.id ?? null);
  const errorFor = (field: string) => (error?.field === field ? error.message : null);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title,
        body,
        linkUrl,
        isEvent,
        eventStartsAt: isEvent && startsAt ? new Date(startsAt).toISOString() : null,
        eventLocation: isEvent ? location : null,
        rsvpEnabled: isEvent && rsvpEnabled,
        eventAge21: isEvent && age21,
        rsvpListPublic: isEvent && rsvpEnabled && attendeesPublic,
        guestVisible,
        audience,
        groupIds: audience === 'groups' ? groupIds : [],
      };
      let saved = savedId.current
        ? (await api.put<{ post: FeedPost }>(`/community/posts/${savedId.current}`, payload)).post
        : (await api.post<{ post: FeedPost }>('/community/posts', payload)).post;
      savedId.current = saved.id;
      if (image) {
        const form = new FormData();
        form.set('file', image);
        saved = (await api.post<{ post: FeedPost }>(`/community/posts/${saved.id}/image`, form)).post;
      } else if (removeImage && post?.imageUrl) {
        saved = (await api.delete<{ post: FeedPost }>(`/community/posts/${saved.id}/image`)).post;
      }
      toast.success(saved.status === 'pending' ? 'Sent to the ECenter for approval.' : 'Posted to the feed.');
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof ApiError ? { message: caught.message, field: caught.field } : { message: 'Could not save the post.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={post ? 'Edit post' : 'New post'}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => save()} disabled={busy}>
            {busy ? 'Saving...' : needsApproval ? 'Submit for approval' : post ? 'Save changes' : 'Post'}
          </button>
        </div>
      }
    >
      <form onSubmit={save} className="space-y-4" noValidate>
        {needsApproval && (
          <p className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">
            {post?.status === 'published'
              ? 'Edits go back to the ECenter for approval. Your post is hidden until they approve it.'
              : 'The ECenter reviews posts before they appear in the feed.'}
          </p>
        )}
        <Field label="Title" required error={errorFor('Title')}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} invalid={!!errorFor('Title')} />
        </Field>
        <Field label="Post" required error={errorFor('Body')}>
          <MentionTextarea id="post-body" value={body} onChange={setBody} rows={6} maxLength={10000} invalid={!!errorFor('Body')} />
        </Field>
        <Field label="Link" error={errorFor('Link')} hint="Optional.">
          <TextInput type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" invalid={!!errorFor('Link')} />
        </Field>

        <div>
          <Checkbox label="This is an event" checked={isEvent} onChange={setIsEvent} />
          {isEvent && (
            <div className="mt-2 space-y-3 rounded-lg border border-slate-200 p-3">
              <Field label="Date & time" required error={errorFor('Event start')}>
                <TextInput type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} invalid={!!errorFor('Event start')} />
              </Field>
              <Field label="Location" error={errorFor('Event location')}>
                <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room, building or online link" />
              </Field>
              <Checkbox label={'Let people say "I\'ll be there!"'} checked={rsvpEnabled} onChange={setRsvpEnabled} />
              <EventOptionFields
                rsvpEnabled={rsvpEnabled}
                age21={age21}
                onAge21={setAge21}
                attendeesPublic={attendeesPublic}
                onAttendeesPublic={setAttendeesPublic}
              />
            </div>
          )}
        </div>

        <AudienceField audience={audience} onAudience={setAudience} groupIds={groupIds} onGroupIds={setGroupIds} error={errorFor('Groups')} />
        {audience === 'everyone' && <GuestVisibilityField value={guestVisible} onChange={setGuestVisible} />}

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
