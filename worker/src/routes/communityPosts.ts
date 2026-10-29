import type { SqlParam } from '../db/driver.ts';
import { badRequest, forbidden, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { recordMentions, sanitizeMentions } from '../lib/mentions.ts';
import { enforceRateLimit } from '../lib/rateLimit.ts';
import { nowIso } from '../lib/time.ts';
import { optionalId, positiveInt, requiredString } from '../lib/validate.ts';
import {
  isStaffRole,
  requireActiveCommunityMember,
  requireCommunityViewer,
  requireSession,
} from '../middleware/auth.ts';
import type { AuthContext, Ctx, Router } from '../router.ts';
import { photoUrl } from '../services/community.ts';
import { storeCommunityUpload } from '../services/communityFiles.ts';
import { postAudienceVisibleSql, replacePostGroupsWrites, resolvePostGroups } from '../services/groups.ts';
import { enqueueMentionNotifications } from '../services/notifications.ts';
import {
  POST_SELECT,
  communityPostOut,
  effectivePostPermission,
  isModerator,
  parsePostFields,
  recordRevision,
  viewerParams,
} from '../services/posts.ts';
import { deleteObject } from '../services/storage.ts';

/**
 * Community posts, comments, likes, RSVPs and events.
 *
 * Reading needs an active community member (or staff). Liking, commenting
 * and RSVPing act as a community identity, so staff need their staff
 * identity for those -- but staff moderators (owners/editors) can remove any
 * comment or post without one. Members can write posts only with posting
 * permission; see services/posts.ts for the rules.
 */

const COMMENT_MAX = 2000;

function moderator(auth: AuthContext): boolean {
  return isStaffRole(auth.role) && isModerator(auth);
}

async function loadPost(ctx: Ctx, postId: string, viewer: AuthContext) {
  return ctx.db.get<Record<string, unknown>>(
    `${POST_SELECT} WHERE p.id = ? AND p.customer_id = ? AND p.deleted_at IS NULL`,
    [...viewerParams(viewer), postId, viewer.customerId],
  );
}

/** Group-only posts are visible to members of (public or joined) groups, the author and moderators. */
async function canSeeAudience(ctx: Ctx, row: Record<string, unknown>, viewer: AuthContext): Promise<boolean> {
  if (String(row.audience ?? 'everyone') === 'everyone') return true;
  if (String(row.author_id) === viewer.userId || moderator(viewer)) return true;
  const ok = await ctx.db.get(`SELECT 1 AS ok FROM posts p WHERE p.id = ? AND ${postAudienceVisibleSql()}`, [
    String(row.id),
    viewer.userId,
  ]);
  return !!ok;
}

/** A published post anyone in the community can see; otherwise only its author or a moderator. */
async function requireVisiblePost(ctx: Ctx, postId: string, viewer: AuthContext) {
  const row = await loadPost(ctx, postId, viewer);
  if (!row) throw notFound('That post is not available.');
  const visible =
    String(row.status) === 'published' || String(row.author_id) === viewer.userId || moderator(viewer);
  if (!visible || !(await canSeeAudience(ctx, row, viewer))) throw notFound('That post is not available.');
  return row;
}

async function requirePublishedPost(ctx: Ctx, postId: string, viewer: AuthContext) {
  const row = await loadPost(ctx, postId, viewer);
  if (!row || String(row.status) !== 'published' || !(await canSeeAudience(ctx, row, viewer))) {
    throw notFound('That post is not available.');
  }
  return row;
}

/** Who said "I'll be there": public profile basics only. */
async function attendeesFor(ctx: Ctx, targetType: 'post' | 'event', targetId: string) {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT r.user_id, r.created_at, p.first_name, p.last_name, p.photo_key, ca.account_type
       FROM event_rsvps r
       JOIN community_accounts ca ON ca.user_id = r.user_id AND ca.status = 'active'
       LEFT JOIN community_profiles p ON p.user_id = r.user_id
      WHERE r.target_type = ? AND r.target_id = ?
      ORDER BY r.created_at ASC LIMIT 500`,
    [targetType, targetId],
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: String(row.user_id),
      name: `${String(row.first_name ?? '')} ${String(row.last_name ?? '')}`.trim() || 'Member',
      accountType: String(row.account_type ?? 'student'),
      photoUrl: await photoUrl(ctx, String(row.user_id), row.photo_key),
    })),
  );
}

/** Upcoming events for a viewer (null = guest), including competition deadlines. */
export async function upcomingEvents(
  ctx: Ctx,
  customerId: string,
  viewerId: string | null,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const now = nowIso();
  // Events with a single date & time stay listed for a few hours after they start.
  const startedSince = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const guest = viewerId === null;
  return ctx.db.all<Record<string, unknown>>(
    `SELECT * FROM (
       SELECT 'event' AS source, id, name, starts_at, ends_at, location, NULL AS competition_id FROM events
        WHERE customer_id = ? AND deleted_at IS NULL AND community_visible = 1
          ${guest ? 'AND community_guest_visible = 1' : ''}
          AND (ends_at >= ? OR (ends_at IS NULL AND starts_at >= ?))
       UNION ALL
       SELECT 'post' AS source, p.id, p.title AS name, p.event_starts_at AS starts_at, p.event_ends_at AS ends_at,
              p.event_location AS location, NULL AS competition_id FROM posts p
        WHERE p.customer_id = ? AND p.deleted_at IS NULL AND p.status = 'published' AND p.event_starts_at IS NOT NULL
          AND ${guest ? `p.audience = 'everyone' AND p.guest_visible = 1` : postAudienceVisibleSql()}
          AND (p.event_ends_at >= ? OR (p.event_ends_at IS NULL AND p.event_starts_at >= ?))
       UNION ALL
       SELECT 'deadline' AS source, d.id, c.title || ': ' || d.label AS name, d.due_at AS starts_at, NULL AS ends_at,
              NULL AS location, c.id AS competition_id
         FROM competition_deadlines d JOIN competitions c ON c.id = d.competition_id
        WHERE d.customer_id = ? AND c.status = 'published' AND c.deleted_at IS NULL AND d.due_at >= ?
     ) ORDER BY starts_at ASC LIMIT ?`,
    [
      customerId, now, startedSince,
      customerId, ...(guest ? [] : [viewerId]), now, startedSince,
      customerId, startedSince,
      limit,
    ],
  );
}

async function commentsFor(ctx: Ctx, postId: string, postAuthorId: string | null, viewer: AuthContext) {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT c.id, c.user_id, c.parent_id, c.body, c.created_at, c.updated_at,
            p.first_name, p.last_name, p.photo_key, ca.account_type, ca.status, u.name AS user_name
       FROM post_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN community_profiles p ON p.user_id = c.user_id
       LEFT JOIN community_accounts ca ON ca.user_id = c.user_id
      WHERE c.post_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT 500`,
    [postId],
  );
  const canModerate = moderator(viewer);
  const out = await Promise.all(
    rows.map(async (row) => {
      const available = String(row.status ?? '') === 'active';
      const userId = String(row.user_id);
      return {
        id: String(row.id),
        parentId: row.parent_id ? String(row.parent_id) : null,
        body: String(row.body),
        createdAt: String(row.created_at),
        author: {
          id: available ? userId : null,
          name: row.first_name ? `${String(row.first_name)} ${String(row.last_name ?? '')}`.trim() : String(row.user_name ?? 'Member'),
          accountType: String(row.account_type ?? 'staff'),
          photoUrl: available ? await photoUrl(ctx, userId, row.photo_key) : null,
          isPostAuthor: !!postAuthorId && userId === postAuthorId,
        },
        canDelete: userId === viewer.userId || postAuthorId === viewer.userId || canModerate,
      };
    }),
  );
  // Replies are listed under their top-level comment.
  const top = out.filter((c) => !c.parentId);
  return top.map((comment) => ({ ...comment, replies: out.filter((c) => c.parentId === comment.id) }));
}

export function publicEvent(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    source: String(row.source) as 'event' | 'post' | 'deadline',
    competitionId: row.competition_id ? String(row.competition_id) : null,
    name: String(row.name),
    startsAt: String(row.starts_at),
    endsAt: row.ends_at ? String(row.ends_at) : null,
    location: row.location ? String(row.location) : null,
  };
}

export function register(router: Router): void {
  /* --------------------------------------------------------- feed -- */

  /** Published posts only, newest first, keyset-paginated. Pending, draft and removed posts never appear. */
  router.get('/api/community/feed', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const limit = positiveInt(ctx.query.get('limit'), 10, 30);
    // Group-only posts appear in their groups' feeds, never the main feed.
    const where = [
      `p.customer_id = ?`,
      `p.status = 'published'`,
      `p.deleted_at IS NULL`,
      `p.published_at IS NOT NULL`,
      `p.audience = 'everyone'`,
    ];
    const params: SqlParam[] = [auth.customerId];
    const cursor = ctx.query.get('cursor');
    if (cursor) {
      const [publishedAt, id] = cursor.split('|');
      if (!publishedAt || !id) throw badRequest('Invalid cursor.');
      where.push('(p.published_at < ? OR (p.published_at = ? AND p.id < ?))');
      params.push(publishedAt, publishedAt, id);
    }
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${POST_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.published_at DESC, p.id DESC LIMIT ?`,
      [...viewerParams(auth), ...params, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return jsonResponse({
      posts: await Promise.all(page.map((row) => communityPostOut(ctx, row, auth))),
      nextCursor: rows.length > limit && last ? `${String(last.published_at)}|${String(last.id)}` : null,
    });
  });

  router.get('/api/community/posts/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await requireVisiblePost(ctx, ctx.params.id!, auth);
    return jsonResponse({
      post: await communityPostOut(ctx, row, auth),
      comments: String(row.status) === 'published' ? await commentsFor(ctx, String(row.id), row.author_id ? String(row.author_id) : null, auth) : [],
    });
  });

  /* ----------------------------------------------- likes & comments -- */

  router.post('/api/community/posts/:id/like', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const row = await requirePublishedPost(ctx, ctx.params.id!, auth);
    const body = await readJson(ctx.req);
    if (body.liked === false) {
      await ctx.db.run(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, [row.id as string, auth.userId]);
    } else {
      await ctx.db.run(
        `INSERT OR IGNORE INTO post_likes (post_id, user_id, customer_id, created_at) VALUES (?, ?, ?, ?)`,
        [row.id as string, auth.userId, auth.customerId, nowIso()],
      );
    }
    const count = await ctx.db.get<{ total: unknown; mine: unknown }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM post_likes WHERE post_id = ?`,
      [auth.userId, row.id as string],
    );
    return jsonResponse({ likeCount: Number(count?.total ?? 0), likedByMe: Number(count?.mine ?? 0) > 0 });
  });

  router.post('/api/community/posts/:id/comments', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const post = await requirePublishedPost(ctx, ctx.params.id!, auth);
    const body = await readJson(ctx.req);
    const raw = requiredString(body.body, 'Comment', { max: COMMENT_MAX });
    await enforceRateLimit(ctx.db, `comment:${auth.userId}`, {
      limit: 10,
      windowSeconds: 60,
      message: 'You are commenting very quickly. Please wait a moment.',
    });

    // Replies attach to the top-level comment, keeping threads one level deep.
    let parentId = optionalId(body.parentId, 'Reply to');
    if (parentId) {
      const parent = await ctx.db.get<{ parent_id: string | null }>(
        `SELECT parent_id FROM post_comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL`,
        [parentId, post.id as string],
      );
      if (!parent) throw badRequest('That comment is no longer available.', 'Reply to');
      parentId = parent.parent_id ?? parentId;
    }

    const { text, userIds } = await sanitizeMentions(ctx.db, auth.customerId, raw);
    const id = newId();
    const timestamp = nowIso();
    await ctx.db.run(
      `INSERT INTO post_comments (id, customer_id, post_id, user_id, parent_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, auth.customerId, post.id as string, auth.userId, parentId, text, timestamp, timestamp],
    );
    await recordMentions(ctx.db, { customerId: auth.customerId, sourceType: 'comment', sourceId: id, userIds });
    await enqueueMentionNotifications(ctx.db, {
      customerId: auth.customerId,
      sourceType: 'comment',
      sourceId: id,
      actorId: auth.userId,
      userIds,
    });
    return jsonResponse(
      { comments: await commentsFor(ctx, String(post.id), post.author_id ? String(post.author_id) : null, auth) },
      { status: 201 },
    );
  });

  /** The comment's author, the post's author, or a staff moderator may remove a comment (and its replies). */
  router.delete('/api/community/comments/:id', async (ctx: Ctx) => {
    const auth = requireSession(ctx);
    const comment = await ctx.db.get<{ id: string; user_id: string; post_id: string; post_author: string | null }>(
      `SELECT c.id, c.user_id, c.post_id, p.author_id AS post_author
         FROM post_comments c JOIN posts p ON p.id = c.post_id
        WHERE c.id = ? AND c.customer_id = ? AND c.deleted_at IS NULL`,
      [ctx.params.id!, auth.customerId],
    );
    if (!comment) throw notFound('That comment is no longer available.');
    const allowed = comment.user_id === auth.userId || comment.post_author === auth.userId || moderator(auth);
    if (!allowed) throw forbidden('You can only remove your own comments, or comments on your own posts.');
    const timestamp = nowIso();
    await ctx.db.run(
      `UPDATE post_comments SET deleted_at = ?, deleted_by = ?
        WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL`,
      [timestamp, auth.userId, comment.id, comment.id],
    );
    return jsonResponse({ ok: true });
  });

  /* -------------------------------------------------------- RSVPs -- */

  router.post('/api/community/posts/:id/rsvp', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const post = await requirePublishedPost(ctx, ctx.params.id!, auth);
    if (!post.event_starts_at || Number(post.rsvp_enabled) !== 1) throw badRequest('This post does not take RSVPs.');
    return jsonResponse(
      await setRsvp(ctx, auth, 'post', String(post.id), await readJson(ctx.req), Number(post.event_age21) === 1),
    );
  });

  /** The attendee list: public if the organiser chose so; always for the author and moderators. */
  router.get('/api/community/posts/:id/attendees', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const post = await requirePublishedPost(ctx, ctx.params.id!, auth);
    const allowed =
      Number(post.rsvp_list_public) === 1 || String(post.author_id) === auth.userId || moderator(auth);
    if (!allowed) throw forbidden('The organiser has not shared who is going.');
    return jsonResponse({ attendees: await attendeesFor(ctx, 'post', String(post.id)) });
  });

  router.get('/api/community/events/:id/attendees', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const event = await ctx.db.get<{ id: string; community_rsvp_public: number }>(
      `SELECT id, community_rsvp_public FROM events
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL AND community_visible = 1`,
      [ctx.params.id!, auth.customerId],
    );
    if (!event) throw notFound('That event is not available.');
    if (Number(event.community_rsvp_public) !== 1 && !moderator(auth)) {
      throw forbidden('The ECenter has not shared who is going.');
    }
    return jsonResponse({ attendees: await attendeesFor(ctx, 'event', event.id) });
  });

  router.post('/api/community/events/:id/rsvp', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const event = await ctx.db.get<{ id: string; community_rsvp: number; community_age21: number }>(
      `SELECT id, community_rsvp, community_age21 FROM events
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL AND community_visible = 1`,
      [ctx.params.id!, auth.customerId],
    );
    if (!event) throw notFound('That event is not available.');
    if (Number(event.community_rsvp) !== 1) throw badRequest('This event does not take RSVPs.');
    return jsonResponse(
      await setRsvp(ctx, auth, 'event', event.id, await readJson(ctx.req), Number(event.community_age21) === 1),
    );
  });

  /* ------------------------------------------------------- events -- */

  /** Upcoming events: community-visible CRM events plus published event posts. */
  router.get('/api/community/events', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const limit = positiveInt(ctx.query.get('limit'), 5, 30);
    const rows = await upcomingEvents(ctx, auth.customerId, auth.userId, limit);
    return jsonResponse({ events: rows.map(publicEvent) });
  });

  /** A community-visible CRM event: public fields only (never staff notes or attendees). */
  router.get('/api/community/events/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await ctx.db.get<Record<string, unknown>>(
      `SELECT e.id, e.name, e.starts_at, e.ends_at, e.location, e.community_details, e.community_rsvp,
              e.community_age21, e.community_rsvp_public, e.community_guest_visible,
              (SELECT COUNT(*) FROM event_rsvps r WHERE r.target_type = 'event' AND r.target_id = e.id) AS rsvp_count,
              EXISTS (SELECT 1 FROM event_rsvps r WHERE r.target_type = 'event' AND r.target_id = e.id AND r.user_id = ?) AS going
         FROM events e
        WHERE e.id = ? AND e.customer_id = ? AND e.deleted_at IS NULL AND e.community_visible = 1`,
      [auth.userId, ctx.params.id!, auth.customerId],
    );
    if (!row) throw notFound('That event is not available.');
    return jsonResponse({
      event: {
        id: String(row.id),
        name: String(row.name),
        startsAt: String(row.starts_at),
        endsAt: row.ends_at ? String(row.ends_at) : null,
        location: row.location ? String(row.location) : null,
        details: row.community_details ? String(row.community_details) : null,
        rsvpEnabled: Number(row.community_rsvp) === 1,
        rsvpCount: Number(row.rsvp_count ?? 0),
        going: Number(row.going ?? 0) === 1,
        age21: Number(row.community_age21) === 1,
        attendeesPublic: Number(row.community_rsvp_public) === 1,
        guestVisible: Number(row.community_guest_visible) === 1,
      },
    });
  });

  /* ------------------------------------------------- member posts -- */

  router.get('/api/community/my-posts', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${POST_SELECT} WHERE p.author_id = ? AND p.customer_id = ? AND p.deleted_at IS NULL
        ORDER BY COALESCE(p.published_at, p.updated_at) DESC, p.id DESC LIMIT 200`,
      [...viewerParams(auth), auth.userId, auth.customerId],
    );
    return jsonResponse({ posts: await Promise.all(rows.map((row) => communityPostOut(ctx, row, auth))) });
  });

  router.post('/api/community/posts', async (ctx: Ctx) => {
    const { auth, account } = await requireActiveCommunityMember(ctx);
    const permission = await permissionFor(ctx, auth, account.account_type);
    if (permission === 'none') throw forbidden('Your account cannot create posts. Contact the ECenter if you would like to.');
    await enforceRateLimit(ctx.db, `member-post:${auth.userId}`, {
      limit: 10,
      windowSeconds: 3600,
      message: 'You have posted a lot recently. Please try again later.',
    });
    const body = await readJson(ctx.req);
    const fields = await parsePostFields(ctx.db, auth.customerId, body);
    const groupIds = await resolvePostGroups(ctx.db, auth, fields.audience, body.groupIds);
    const id = newId();
    const timestamp = nowIso();
    const status = permission === 'direct' ? 'published' : 'pending';
    await ctx.db.batch([
      {
        sql: `INSERT INTO posts (id, customer_id, title, body, link_url, status, published_at, author_id, author_kind,
                            event_starts_at, event_ends_at, event_location, rsvp_enabled,
                            event_age21, rsvp_list_public, guest_visible, audience,
                            created_at, updated_at, created_by, last_edited_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'member', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id, auth.customerId, fields.title, fields.body, fields.linkUrl, status,
          status === 'published' ? timestamp : null, auth.userId,
          fields.eventStartsAt, fields.eventEndsAt, fields.eventLocation, fields.rsvpEnabled,
          fields.eventAge21, fields.rsvpListPublic, fields.guestVisible, fields.audience,
          timestamp, timestamp, auth.userId, auth.userId,
        ],
      },
      ...replacePostGroupsWrites(id, auth.customerId, groupIds),
    ]);
    await recordMentions(ctx.db, { customerId: auth.customerId, sourceType: 'post', sourceId: id, userIds: fields.mentionIds });
    if (status === 'published') {
      await enqueueMentionNotifications(ctx.db, {
        customerId: auth.customerId, sourceType: 'post', sourceId: id, actorId: auth.userId, userIds: fields.mentionIds,
      });
    }
    const row = await loadPost(ctx, id, auth);
    return jsonResponse({ post: await communityPostOut(ctx, row!, auth) }, { status: 201 });
  });

  /**
   * Authors edit their own posts. With approval-required posting, an edit to
   * a published or rejected post sends it back for review, so approved
   * content cannot be quietly replaced. The previous version is kept.
   */
  router.put('/api/community/posts/:id', async (ctx: Ctx) => {
    const { auth, account } = await requireActiveCommunityMember(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth);
    if (!existing || String(existing.author_id) !== auth.userId) throw notFound('That post is not available.');
    const permission = await permissionFor(ctx, auth, account.account_type);
    if (permission === 'none') throw forbidden('Your account cannot edit posts. You can still remove them.');
    if (String(existing.status) === 'archived') throw badRequest('This post was archived by the ECenter and cannot be edited.');

    const body = await readJson(ctx.req);
    const fields = await parsePostFields(ctx.db, auth.customerId, body);
    const groupIds = await resolvePostGroups(ctx.db, auth, fields.audience, body.groupIds);
    const timestamp = nowIso();
    const nextStatus = permission === 'direct' ? 'published' : 'pending';
    await recordRevision(ctx.db, { postId: String(existing.id), action: 'edit', changedBy: auth.userId });
    await ctx.db.batch([
      {
        sql: `UPDATE posts SET title = ?, body = ?, link_url = ?, event_starts_at = ?, event_ends_at = ?, event_location = ?,
                rsvp_enabled = ?, event_age21 = ?, rsvp_list_public = ?, guest_visible = ?, audience = ?, status = ?,
                published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
                review_note = NULL, updated_at = ?, last_edited_by = ?
          WHERE id = ?`,
        params: [
          fields.title, fields.body, fields.linkUrl, fields.eventStartsAt, fields.eventEndsAt, fields.eventLocation,
          fields.rsvpEnabled, fields.eventAge21, fields.rsvpListPublic, fields.guestVisible, fields.audience,
          nextStatus, nextStatus, timestamp, timestamp, auth.userId, String(existing.id),
        ],
      },
      ...replacePostGroupsWrites(String(existing.id), auth.customerId, groupIds),
    ]);
    await recordMentions(ctx.db, { customerId: auth.customerId, sourceType: 'post', sourceId: String(existing.id), userIds: fields.mentionIds });
    if (nextStatus === 'published') {
      await enqueueMentionNotifications(ctx.db, {
        customerId: auth.customerId, sourceType: 'post', sourceId: String(existing.id), actorId: auth.userId, userIds: fields.mentionIds,
      });
    }
    const row = await loadPost(ctx, String(existing.id), auth);
    return jsonResponse({ post: await communityPostOut(ctx, row!, auth) });
  });

  /** The author or a staff moderator takes a post down. It is kept (soft-deleted) for the history log. */
  router.delete('/api/community/posts/:id', async (ctx: Ctx) => {
    const auth = requireSession(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth);
    if (!existing) throw notFound('That post is not available.');
    if (String(existing.author_id) !== auth.userId && !moderator(auth)) {
      throw forbidden('You can only remove your own posts.');
    }
    await recordRevision(ctx.db, { postId: String(existing.id), action: 'delete', changedBy: auth.userId });
    const timestamp = nowIso();
    await ctx.db.run(`UPDATE posts SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?`, [
      timestamp, auth.userId, timestamp, String(existing.id),
    ]);
    return jsonResponse({ ok: true });
  });

  router.post('/api/community/posts/:id/image', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth);
    if (!existing || String(existing.author_id) !== auth.userId) throw notFound('That post is not available.');
    const stored = await storeCommunityUpload(ctx, { purpose: 'post-image', customerId: auth.customerId, ownerId: String(existing.id) });
    await ctx.db.run(`UPDATE posts SET image_key = ?, image_type = ?, updated_at = ? WHERE id = ?`, [
      stored.key, stored.type, nowIso(), String(existing.id),
    ]);
    if (existing.image_key) await deleteObject(ctx.env.DOCS, String(existing.image_key)).catch(() => undefined);
    const row = await loadPost(ctx, String(existing.id), auth);
    return jsonResponse({ post: await communityPostOut(ctx, row!, auth) });
  });

  router.delete('/api/community/posts/:id/image', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth);
    if (!existing || String(existing.author_id) !== auth.userId) throw notFound('That post is not available.');
    await ctx.db.run(`UPDATE posts SET image_key = NULL, image_type = NULL, updated_at = ? WHERE id = ?`, [
      nowIso(), String(existing.id),
    ]);
    if (existing.image_key) await deleteObject(ctx.env.DOCS, String(existing.image_key)).catch(() => undefined);
    const row = await loadPost(ctx, String(existing.id), auth);
    return jsonResponse({ post: await communityPostOut(ctx, row!, auth) });
  });
}

async function permissionFor(ctx: Ctx, auth: AuthContext, accountType: string) {
  const row = await ctx.db.get<{ post_permission: string | null }>(
    `SELECT post_permission FROM community_accounts WHERE user_id = ?`,
    [auth.userId],
  );
  return effectivePostPermission(accountType, row?.post_permission ?? null, auth.role);
}

async function setRsvp(
  ctx: Ctx,
  auth: AuthContext,
  targetType: 'post' | 'event',
  targetId: string,
  body: Record<string, unknown>,
  age21: boolean,
) {
  const going = body.going !== false;
  if (going) {
    // A 21+ event needs the attendee's "I'm over 21" confirmation.
    if (age21 && body.over21 !== true) {
      throw badRequest('This is a 21+ event. Confirm you are 21 or older to RSVP.', 'Over 21');
    }
    await ctx.db.run(
      `INSERT INTO event_rsvps (target_type, target_id, user_id, customer_id, over21_confirmed, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id, user_id) DO UPDATE SET over21_confirmed = excluded.over21_confirmed`,
      [targetType, targetId, auth.userId, auth.customerId, age21 ? 1 : 0, nowIso()],
    );
  } else {
    await ctx.db.run(`DELETE FROM event_rsvps WHERE target_type = ? AND target_id = ? AND user_id = ?`, [
      targetType, targetId, auth.userId,
    ]);
  }
  const count = await ctx.db.get<{ total: unknown }>(
    `SELECT COUNT(*) AS total FROM event_rsvps WHERE target_type = ? AND target_id = ?`,
    [targetType, targetId],
  );
  return { going, rsvpCount: Number(count?.total ?? 0) };
}
