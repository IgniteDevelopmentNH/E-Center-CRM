import type { Db, SqlParam } from '../db/driver.ts';
import { badRequest } from '../lib/http.ts';
import { optionalWebLink } from '../lib/communityValidate.ts';
import { newId } from '../lib/ids.ts';
import { sanitizeMentions } from '../lib/mentions.ts';
import { nowIso } from '../lib/time.ts';
import { flag, optionalString, optionalTimestamp, requiredString } from '../lib/validate.ts';
import type { AuthContext, Ctx } from '../router.ts';
import { isStaffRole } from '../middleware/auth.ts';
import { photoUrl } from './community.ts';
import { signValue } from '../lib/signedToken.ts';

/**
 * Posts are written by staff (from the CRM) and, with permission, by members
 * (from the portal). One set of rules for both:
 *
 *   Posting permission (community_accounts.post_permission, NULL = default)
 *     student -> none        mentor -> none           staff identity -> direct (editors/owners)
 *   Staff grant posting to individual members in Admin > Members.
 *   none      cannot post
 *   approval  posts (and later edits) wait as `pending` until staff approve
 *   direct    posts publish immediately
 *
 *   Status: draft | pending | published | rejected | archived (+ soft delete)
 *
 * Every edit, takedown, restore and review decision snapshots the previous
 * content into post_revisions, which staff can read in Admin > Settings.
 */

export const POST_PERMISSIONS = ['none', 'approval', 'direct'] as const;
export type PostPermission = (typeof POST_PERMISSIONS)[number];

export function effectivePostPermission(
  accountType: string,
  stored: string | null | undefined,
  userRole: string,
): PostPermission {
  if (stored && (POST_PERMISSIONS as readonly string[]).includes(stored)) return stored as PostPermission;
  // Students and mentors cannot post until staff grant it per person.
  if (accountType === 'staff') return isStaffRole(userRole) && userRole !== 'viewer' ? 'direct' : 'none';
  return 'none';
}

/** Owners/editors moderate everything; viewers are read-only staff. */
export function isModerator(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'editor';
}

/* -------------------------------------------------------------- input -- */

export interface PostFields {
  title: string;
  body: string;
  linkUrl: string | null;
  eventStartsAt: string | null;
  eventEndsAt: string | null;
  eventLocation: string | null;
  rsvpEnabled: 0 | 1;
  /** 21+ event: an RSVP must confirm "I'm over 21". */
  eventAge21: 0 | 1;
  /** Members can see who is going. */
  rsvpListPublic: 0 | 1;
  /** Guests (no account) can see it in the main feed. */
  guestVisible: 0 | 1;
  /** Main feed, or only the feeds of chosen groups. */
  audience: 'everyone' | 'groups';
  mentionIds: string[];
}

export async function parsePostFields(db: Db, customerId: string, body: Record<string, unknown>): Promise<PostFields> {
  const title = requiredString(body.title, 'Title', { max: 200 });
  const rawBody = requiredString(body.body, 'Body', { max: 10000 });
  const { text, userIds } = await sanitizeMentions(db, customerId, rawBody);

  // An event post has one date & time for the whole event (no separate end).
  const isEvent = flag(body.isEvent) === 1;
  const eventStartsAt = isEvent ? optionalTimestamp(body.eventStartsAt, 'Event start') : null;
  if (isEvent && !eventStartsAt) throw badRequest('Choose the date and time of the event.', 'Event start');
  const eventEndsAt = null;
  return {
    title,
    body: text,
    linkUrl: optionalWebLink(body.linkUrl),
    eventStartsAt,
    eventEndsAt,
    eventLocation: isEvent ? optionalString(body.eventLocation, 'Event location', { max: 200 }) : null,
    rsvpEnabled: isEvent ? flag(body.rsvpEnabled) : 0,
    eventAge21: isEvent ? flag(body.eventAge21) : 0,
    rsvpListPublic: isEvent && flag(body.rsvpEnabled) ? flag(body.rsvpListPublic) : 0,
    // Visible to guests unless the author hides it.
    guestVisible: body.guestVisible === false ? 0 : 1,
    audience: body.audience === 'groups' ? 'groups' : 'everyone',
    mentionIds: userIds,
  };
}

/* ----------------------------------------------------------- history -- */

export async function recordRevision(
  db: Db,
  input: { postId: string; action: 'edit' | 'delete' | 'restore' | 'approve' | 'reject'; changedBy: string },
): Promise<void> {
  await db.run(
    `INSERT INTO post_revisions
       (id, customer_id, post_id, action, title, body, link_url, status, event_starts_at, event_ends_at,
        event_location, changed_by, created_at)
     SELECT ?, customer_id, id, ?, title, body, link_url, status, event_starts_at, event_ends_at,
            event_location, ?, ?
       FROM posts WHERE id = ?`,
    [newId(), input.action, input.changedBy, nowIso(), input.postId],
  );
}

/* ------------------------------------------------------------ output -- */

/**
 * The columns every post view needs. `?` placeholders, in order:
 *   1. viewer user id (liked_by_me)   2. viewer user id (rsvp'd)
 */
export const POST_SELECT = `
  SELECT p.*,
         u.name AS author_user_name, u.role AS author_role,
         ap.first_name AS author_first_name, ap.last_name AS author_last_name, ap.photo_key AS author_photo_key,
         aca.account_type AS author_account_type, aca.status AS author_status,
         e.id AS ev_id, e.name AS ev_name, e.starts_at AS ev_starts_at, e.ends_at AS ev_ends_at, e.location AS ev_location,
         (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
         (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM event_rsvps r WHERE r.target_type = 'post' AND r.target_id = p.id) AS rsvp_count,
         EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked_by_me,
         EXISTS (SELECT 1 FROM event_rsvps r WHERE r.target_type = 'post' AND r.target_id = p.id AND r.user_id = ?) AS rsvp_by_me,
         (SELECT json_group_array(json_object('id', g.id, 'slug', g.slug, 'name', g.name, 'privacy', g.privacy))
            FROM post_groups pg JOIN community_groups g ON g.id = pg.group_id AND g.archived_at IS NULL
           WHERE pg.post_id = p.id) AS groups_json
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN community_profiles ap ON ap.user_id = p.author_id
    LEFT JOIN community_accounts aca ON aca.user_id = p.author_id
    LEFT JOIN events e ON e.id = p.event_id AND e.deleted_at IS NULL AND e.community_visible = 1`;

const IMAGE_TTL_SECONDS = 60 * 60 * 6;

export async function postImageUrl(
  ctx: Ctx,
  postId: string,
  imageKey: unknown,
  scope: 'community' | 'staff',
): Promise<string | null> {
  if (!imageKey) return null;
  const token = await signValue({ k: 'post', p: postId, s: scope }, ctx.config.tokenSecret, IMAGE_TTL_SECONDS);
  return `/api/community/files/post-image/${postId}?token=${encodeURIComponent(token)}`;
}

/**
 * The post as the community sees it. Member authors appear with their public
 * profile (name, photo, type) and link to it; staff posts show as the ECenter.
 */
export async function communityPostOut(ctx: Ctx, row: Record<string, unknown>, viewer: AuthContext | null) {
  const isMemberPost = String(row.author_kind) === 'member';
  const authorId = row.author_id ? String(row.author_id) : null;
  const authorName = row.author_first_name
    ? `${String(row.author_first_name)} ${String(row.author_last_name ?? '')}`.trim()
    : row.author_user_name
      ? String(row.author_user_name)
      : 'UNH ECenter';
  const authorAvailable = String(row.author_status ?? '') === 'active';
  const isAuthor = !!viewer && authorId === viewer.userId;
  const canModerate = !!viewer && isStaffRole(viewer.role) && isModerator(viewer);

  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    linkUrl: row.link_url ? String(row.link_url) : null,
    imageUrl: await postImageUrl(ctx, String(row.id), row.image_key, isAuthor || canModerate ? 'staff' : 'community'),
    status: String(row.status),
    publishedAt: row.published_at ? String(row.published_at) : null,
    updatedAt: String(row.updated_at),
    reviewNote: isAuthor || canModerate ? (row.review_note ? String(row.review_note) : null) : null,
    author: {
      kind: isMemberPost ? ('member' as const) : ('staff' as const),
      // Member authors link to their profile; staff posts are "the ECenter".
      id: isMemberPost && authorAvailable ? authorId : null,
      name: authorName,
      accountType: isMemberPost ? String(row.author_account_type ?? 'student') : 'staff',
      photoUrl: isMemberPost && authorAvailable && authorId ? await photoUrl(ctx, authorId, row.author_photo_key) : null,
    },
    event: row.event_starts_at
      ? {
          startsAt: String(row.event_starts_at),
          endsAt: row.event_ends_at ? String(row.event_ends_at) : null,
          location: row.event_location ? String(row.event_location) : null,
          rsvpEnabled: Number(row.rsvp_enabled) === 1,
          rsvpCount: Number(row.rsvp_count ?? 0),
          going: Number(row.rsvp_by_me ?? 0) === 1,
          age21: Number(row.event_age21) === 1,
          attendeesPublic: Number(row.rsvp_list_public) === 1,
        }
      : null,
    audience: String(row.audience ?? 'everyone') as 'everyone' | 'groups',
    guestVisible: Number(row.guest_visible ?? 1) === 1,
    groups: parseGroups(row.groups_json),
    // A CRM event the post points at (only if still community-visible).
    linkedEvent: row.ev_id
      ? {
          id: String(row.ev_id),
          name: String(row.ev_name),
          startsAt: String(row.ev_starts_at),
          endsAt: row.ev_ends_at ? String(row.ev_ends_at) : null,
          location: row.ev_location ? String(row.ev_location) : null,
        }
      : null,
    likeCount: Number(row.like_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    likedByMe: Number(row.liked_by_me ?? 0) === 1,
    canEdit: isAuthor || canModerate,
    canDelete: isAuthor || canModerate,
  };
}

function parseGroups(value: unknown): { id: string; slug: string; name: string; privacy: string }[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>[];
    return parsed
      .filter((g) => g && g.id)
      .map((g) => ({ id: String(g.id), slug: String(g.slug), name: String(g.name), privacy: String(g.privacy) }));
  } catch {
    return [];
  }
}

export function viewerParams(viewer: AuthContext | null): SqlParam[] {
  const id = viewer?.userId ?? '';
  return [id, id];
}
