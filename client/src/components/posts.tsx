import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../lib/api.ts';
import { formatDate, formatRelative, formatTime, toDateTimeInput } from '../lib/format.ts';
import type { CommunityEventDetail, CompetitionDeadlineItem, FeedPost, PostComment, RegistrationQuestion, RsvpAnswers } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';
import { MemberAvatar, accountTypeLabel } from './community.tsx';
import {
  Age21Badge,
  AttendeesButton,
  AudienceField,
  EventIconRow,
  EventOptionsFields,
  GuestVisibilityField,
  ResponsesButton,
  eventOptionsFrom,
  questionsPayload,
} from './eventOptions.tsx';
import { MentionTextarea, RichText } from './mentions.tsx';
import { Modal } from './overlays.tsx';
import { Checkbox, Field, TextArea, TextInput } from './ui.tsx';

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

const guestTokenKey = (target: string, id: string) => `ecenter-guest-rsvp:${target}:${id}`;

function readGuestToken(target: string, id: string): string | null {
  try {
    return localStorage.getItem(guestTokenKey(target, id));
  } catch {
    return null;
  }
}

function writeGuestToken(target: string, id: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(guestTokenKey(target, id), token);
    else localStorage.removeItem(guestTokenKey(target, id));
  } catch {
    /* storage unavailable: the RSVP still counts, it just can't be undone from this browser */
  }
}

/** Over-21 confirmation, registration questions, and a guest's name and email. */
function RsvpDialog({
  target,
  id,
  title,
  age21,
  questions,
  asGuest,
  editing,
  onClose,
  onDone,
}: {
  target: 'post' | 'event';
  id: string;
  title: string;
  age21: boolean;
  questions: RegistrationQuestion[];
  asGuest: boolean;
  editing: boolean;
  onClose: () => void;
  onDone: (state: { going: boolean; rsvpCount: number; cancelToken?: string | null }) => void;
}) {
  const path = target === 'post' ? 'posts' : 'events';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [over21, setOver21] = useState(editing);
  const [answers, setAnswers] = useState<RsvpAnswers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setAnswer = (questionId: string, value: string | string[]) => setAnswers((current) => ({ ...current, [questionId]: value }));

  useEffect(() => {
    if (!editing) return;
    api
      .get<{ answers: RsvpAnswers }>(`/community/${path}/${id}/rsvp`)
      .then((response) => setAnswers(response.answers))
      .catch(() => undefined);
  }, [editing, path, id]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { going: true, over21: age21 ? over21 : undefined, answers };
      onDone(
        asGuest
          ? await api.post(`/public/${path}/${id}/rsvp`, { ...body, name, email, website })
          : await api.post(`/community/${path}/${id}/rsvp`, body),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Your RSVP did not go through. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const choice = (question: RegistrationQuestion, options: string[]) => (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <label
          key={option}
          className={`chip min-h-[40px] cursor-pointer border px-3 ${
            answers[question.id] === option ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white text-slate-700'
          }`}
        >
          <input type="radio" name={question.id} className="sr-only" checked={answers[question.id] === option} onChange={() => setAnswer(question.id, option)} />
          {option}
        </label>
      ))}
    </div>
  );

  return (
    <Modal
      open
      title={editing ? 'Update your RSVP' : `RSVP: ${title}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => submit()} disabled={busy || (age21 && !over21)}>
            {busy ? 'Saving...' : editing ? 'Save' : "I'll be there!"}
          </button>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {asGuest && (
          <>
            <Field label="Your name" required>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
            </Field>
            <Field label="Email" required hint="Shared with ECenter staff so they can reach you about this event.">
              <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </Field>
            {/* Left empty by people; see the guest RSVP route. */}
            <div className="absolute -left-[9999px]" aria-hidden="true">
              <label>
                Website
                <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
            </div>
          </>
        )}
        {questions.map((question) => (
          <fieldset key={question.id}>
            <legend className="label">
              {question.label}
              {question.required && <span className="ml-0.5 text-urgent">*</span>}
            </legend>
            {question.type === 'yesno' && choice(question, ['Yes', 'No'])}
            {question.type === 'choice' && choice(question, question.options)}
            {question.type === 'checkboxes' &&
              question.options.map((option) => {
                const picked = (answers[question.id] as string[] | undefined) ?? [];
                return (
                  <Checkbox
                    key={option}
                    label={option}
                    checked={picked.includes(option)}
                    onChange={(on) => setAnswer(question.id, on ? [...picked, option] : picked.filter((v) => v !== option))}
                  />
                );
              })}
            {question.type === 'text' && (
              <TextArea rows={2} maxLength={1000} aria-label={question.label} value={(answers[question.id] as string | undefined) ?? ''} onChange={(e) => setAnswer(question.id, e.target.value)} />
            )}
          </fieldset>
        ))}
        {age21 && (
          <div>
            <p className="text-sm text-slate-600">The organiser has marked this event 21 and over.</p>
            <Checkbox label="I'm over 21" checked={over21} onChange={setOver21} />
          </div>
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/** "I'll be there!" for an event post or a community CRM event, for members and (if allowed) guests. */
export function RsvpButton({
  target,
  id,
  title,
  going,
  count,
  age21 = false,
  guestRsvp = false,
  questions = [],
  showAttendees = false,
  showResponses = false,
  onChange,
}: {
  target: 'post' | 'event';
  id: string;
  title: string;
  going: boolean;
  count: number;
  age21?: boolean;
  guestRsvp?: boolean;
  questions?: RegistrationQuestion[];
  /** The organiser shared the list (or the viewer organised it / is staff). */
  showAttendees?: boolean;
  /** The viewer organised this event or is staff, and can see everyone's answers. */
  showResponses?: boolean;
  onChange: (state: { going: boolean; rsvpCount: number }) => void;
}) {
  const { user, isActiveMember } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'new' | 'edit'>(null);
  const [guestToken, setGuestToken] = useState(() => readGuestToken(target, id));
  const isGuest = !user;
  const guestGoing = isGuest && !!guestToken;
  const isGoing = going || guestGoing;
  const path = target === 'post' ? 'posts' : 'events';
  const canRsvp = isActiveMember || (isGuest && guestRsvp);

  async function cancel() {
    setBusy(true);
    try {
      if (isGuest) {
        onChange(await api.post<{ going: boolean; rsvpCount: number }>('/public/rsvp/cancel', { token: guestToken }));
        writeGuestToken(target, id, null);
        setGuestToken(null);
      } else {
        onChange(await api.post<{ going: boolean; rsvpCount: number }>(`/community/${path}/${id}/rsvp`, { going: false }));
      }
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (isGuest || age21 || questions.length) {
      setDialog('new');
      return;
    }
    setBusy(true);
    try {
      onChange(await api.post<{ going: boolean; rsvpCount: number }>(`/community/${path}/${id}/rsvp`, { going: true }));
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {canRsvp && (
        <button type="button" onClick={isGoing ? cancel : join} disabled={busy} aria-pressed={isGoing} className={isGoing ? 'btn-secondary' : 'btn-primary'}>
          {isGoing ? "✓ You're going" : "I'll be there!"}
        </button>
      )}
      {isGuest && !guestRsvp && (
        <Link to={`/login?next=${encodeURIComponent(target === 'post' ? `/posts/${id}` : `/events/${id}`)}`} className="btn-primary">
          Sign in to RSVP
        </Link>
      )}
      {age21 && <Age21Badge />}
      <span className="text-sm text-slate-600" aria-live="polite">
        {count === 0 ? 'Be the first to say you’re going' : `${count} ${count === 1 ? 'person' : 'people'} going`}
      </span>
      {showAttendees && !!user && <AttendeesButton target={target} id={id} count={count} />}
      {showResponses && <ResponsesButton target={target} id={id} title={title} />}
      {isGoing && (
        <span className="w-full text-xs text-slate-500">
          Changed your mind? Tap the button again to remove your RSVP.
          {going && !isGuest && questions.length > 0 && (
            <button type="button" className="ml-1 font-semibold text-teal-700 hover:underline" onClick={() => setDialog('edit')}>
              Change my answers
            </button>
          )}
        </span>
      )}
      {dialog && (
        <RsvpDialog
          target={target}
          id={id}
          title={title}
          age21={age21}
          questions={questions}
          asGuest={isGuest}
          editing={dialog === 'edit'}
          onClose={() => setDialog(null)}
          onDone={(state) => {
            setDialog(null);
            if (state.cancelToken) {
              writeGuestToken(target, id, state.cancelToken);
              setGuestToken(state.cancelToken);
            }
            onChange({ going: state.going, rsvpCount: state.rsvpCount });
          }}
        />
      )}
    </div>
  );
}

/** Group markers shown on an event. */
export function PostBadges({ post }: { post: FeedPost }) {
  if (!post.groups.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
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
  const { event } = post;
  return (
    <article className="card overflow-hidden" aria-labelledby={`post-${post.id}`}>
      {post.imageUrl && (
        <Link to={`/posts/${post.id}`} tabIndex={-1} aria-hidden="true">
          <img src={post.imageUrl} alt="" className="max-h-[320px] w-full border-b border-slate-100 object-cover" loading="lazy" />
        </Link>
      )}
      <div className="space-y-3 p-4 sm:p-6">
        <div className="flex items-start gap-3">
          {event && <DateBadge iso={event.startsAt} size="lg" />}
          <div className="min-w-0">
            <h2 id={`post-${post.id}`} className="text-lg font-bold leading-snug text-navy-800 sm:text-xl">
              <Link to={`/posts/${post.id}`} className="hover:underline">
                {post.title}
              </Link>
            </h2>
            {event && (
              <p className="mt-0.5 text-sm text-slate-600">
                {eventWhen(event.startsAt, event.endsAt)}
                {event.location ? ` · ${event.location}` : ''}
              </p>
            )}
          </div>
        </div>
        {event && <EventIconRow icons={event.icons} />}
        <PostBadges post={post} />
        <div className={long ? 'relative max-h-40 overflow-hidden' : ''}>
          <RichText text={post.body} className="text-[15px] leading-relaxed text-slate-700" />
          {long && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white" aria-hidden="true" />}
        </div>
        {long && (
          <Link to={`/posts/${post.id}`} className="inline-block text-sm font-semibold text-teal-700 hover:underline">
            Read more
          </Link>
        )}
        {post.linkUrl && (
          <a href={post.linkUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-teal-700 hover:underline">
            {hostOf(post.linkUrl)} <span aria-hidden="true">↗</span>
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
        {event?.rsvpEnabled && post.status === 'published' && (
          <RsvpButton
            target="post"
            id={post.id}
            title={post.title}
            going={event.going}
            count={event.rsvpCount}
            age21={event.age21}
            guestRsvp={event.guestRsvp}
            questions={event.questions}
            showAttendees={event.attendeesPublic || post.canEdit}
            onChange={(state) => onChange({ event: { ...event, going: state.going, rsvpCount: state.rsvpCount } })}
          />
        )}
        {event?.age21 && !event.rsvpEnabled && <Age21Badge />}
        <PostAuthor post={post} />
      </div>

      <footer className="flex items-center gap-1 border-t border-slate-100 px-2 py-1 sm:px-4">
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

/** An ECenter event from the CRM, in the feed. */
export function CrmEventCard({ event, onChange }: { event: CommunityEventDetail; onChange: (patch: Partial<CommunityEventDetail>) => void }) {
  const { isStaff } = useAuth();
  return (
    <article className="card overflow-hidden" aria-labelledby={`event-${event.id}`}>
      <div className="h-1.5 bg-teal" aria-hidden="true" />
      <div className="space-y-3 p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <DateBadge iso={event.startsAt} size="lg" />
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-teal-700">UNH ECenter event</p>
            <h2 id={`event-${event.id}`} className="text-lg font-bold leading-snug text-navy-800 sm:text-xl">
              <Link to={`/events/${event.id}`} className="hover:underline">{event.name}</Link>
            </h2>
            <p className="mt-0.5 text-sm text-slate-600">
              {eventWhen(event.startsAt, event.endsAt)}
              {event.location ? ` · ${event.location}` : ''}
            </p>
          </div>
        </div>
        <EventIconRow icons={event.icons} />
        {event.details && <p className="line-clamp-4 whitespace-pre-line text-[15px] leading-relaxed text-slate-700">{event.details}</p>}
        {event.rsvpEnabled && (
          <RsvpButton
            target="event"
            id={event.id}
            title={event.name}
            going={event.going}
            count={event.rsvpCount}
            age21={event.age21}
            guestRsvp={event.guestRsvp}
            questions={event.questions}
            showAttendees={event.attendeesPublic || isStaff}
            onChange={(state) => onChange({ going: state.going, rsvpCount: state.rsvpCount })}
          />
        )}
      </div>
    </article>
  );
}

/** A competition deadline, in the feed. */
export function DeadlineCard({ deadline }: { deadline: CompetitionDeadlineItem }) {
  return (
    <article className="card flex items-center gap-3 border-l-4 border-l-amber-400 p-4 sm:px-6">
      <DateBadge iso={deadline.dueAt} size="lg" />
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wide text-amber-700">Competition deadline</p>
        <h2 className="font-bold leading-snug text-navy-800">
          <Link to={`/competitions/${deadline.competitionId}`} className="hover:underline">{deadline.title}</Link>
        </h2>
        <p className="text-sm text-slate-600">
          {deadline.label} · {formatDate(deadline.dueAt)} at {formatTime(deadline.dueAt)}
        </p>
        {deadline.prize && <p className="text-sm font-semibold text-teal-800">Prize: {deadline.prize}</p>}
      </div>
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

/** Create or edit a member's own event. Posts from before the feed became events-only stay editable as they are. */
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
  const isEvent = !post || !!post.event;
  const [startsAt, setStartsAt] = useState(toDateTimeInput(post?.event?.startsAt ?? null));
  const [location, setLocation] = useState(post?.event?.location ?? '');
  const [options, setOptions] = useState(() => eventOptionsFrom(post?.event));
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
        rsvpEnabled: isEvent && options.rsvpMode !== 'off',
        rsvpGuests: isEvent && options.rsvpMode === 'everyone',
        eventAge21: isEvent && options.age21,
        rsvpListPublic: isEvent && options.attendeesPublic,
        eventIcons: options.icons,
        rsvpQuestions: questionsPayload(options.questions),
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
      toast.success(saved.status === 'pending' ? 'Sent to the ECenter for approval.' : 'Added to the feed.');
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
      title={post ? (isEvent ? 'Edit event' : 'Edit post') : 'New event'}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => save()} disabled={busy}>
            {busy ? 'Saving...' : needsApproval ? 'Submit for approval' : post ? 'Save changes' : 'Add event'}
          </button>
        </div>
      }
    >
      <form onSubmit={save} className="space-y-4" noValidate>
        {needsApproval && (
          <p className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">
            {post?.status === 'published'
              ? 'Edits go back to the ECenter for approval. Your event is hidden until they approve it.'
              : 'The ECenter reviews events before they appear in the feed.'}
          </p>
        )}
        <Field label={isEvent ? 'Event name' : 'Title'} required error={errorFor('Title')}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} invalid={!!errorFor('Title')} />
        </Field>
        {isEvent && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date & time" required error={errorFor('Event start')}>
              <TextInput type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} invalid={!!errorFor('Event start')} />
            </Field>
            <Field label="Location" error={errorFor('Event location')}>
              <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room, building or online link" />
            </Field>
          </div>
        )}
        <Field label={isEvent ? 'Details' : 'Post'} required error={errorFor('Body')}>
          <MentionTextarea id="post-body" value={body} onChange={setBody} rows={6} maxLength={10000} invalid={!!errorFor('Body')} />
        </Field>
        <Field label="Link" error={errorFor('Link')} hint="Optional.">
          <TextInput type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" invalid={!!errorFor('Link')} />
        </Field>

        {isEvent && (
          <EventOptionsFields value={options} onChange={setOptions} guestVisible={guestVisible && audience === 'everyone'} errorFor={errorFor} />
        )}

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
