import type { SqlParam } from '../db/driver.ts';
import type { AuditAction } from '../lib/audit.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { recordMentions } from '../lib/mentions.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, optionalId, optionalString, positiveInt } from '../lib/validate.ts';
import { requireEditor, requireStaff } from '../middleware/auth.ts';
import type { AuthContext, Ctx, Router } from '../router.ts';
import { storeCommunityUpload } from '../services/communityFiles.ts';
import { enqueueAnnouncement, enqueueMentionNotifications } from '../services/notifications.ts';
import { parsePostFields, postImageUrl, recordRevision } from '../services/posts.ts';
import { deleteObject } from '../services/storage.ts';

/**
 * Admin > Posts. Owners and editors create, edit, publish, unpublish, archive,
 * take down and restore posts, approve or reject member submissions, and can
 * email members about a published post. Viewers read. Community members are
 * refused outright by requireStaff.
 */

const POST_STATUSES = ['draft', 'pending', 'published', 'rejected', 'archived'] as const;

const SELECT_POST = `
  SELECT p.*, u.name AS author_user_name,
         ap.first_name AS author_first_name, ap.last_name AS author_last_name,
         aca.account_type AS author_account_type,
         e.name AS event_name, e.starts_at AS event_linked_starts_at, e.community_visible AS event_community_visible,
         reviewer.name AS reviewed_by_name,
         (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
         (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM event_rsvps r WHERE r.target_type = 'post' AND r.target_id = p.id) AS rsvp_count,
         (SELECT COUNT(*) FROM post_revisions pr WHERE pr.post_id = p.id) AS revision_count
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN community_profiles ap ON ap.user_id = p.author_id
    LEFT JOIN community_accounts aca ON aca.user_id = p.author_id
    LEFT JOIN users reviewer ON reviewer.id = p.reviewed_by
    LEFT JOIN events e ON e.id = p.event_id AND e.deleted_at IS NULL`;

async function adminPostOut(ctx: Ctx, row: Record<string, unknown>) {
  const memberAuthor = String(row.author_kind) === 'member';
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    linkUrl: row.link_url ? String(row.link_url) : null,
    imageUrl: await postImageUrl(ctx, String(row.id), row.image_key, 'staff'),
    eventId: row.event_id ? String(row.event_id) : null,
    eventName: row.event_name ? String(row.event_name) : null,
    eventStartsAt: row.event_linked_starts_at ? String(row.event_linked_starts_at) : null,
    eventCommunityVisible: Number(row.event_community_visible ?? 0) === 1,
    isEvent: !!row.event_starts_at,
    eventDetails: row.event_starts_at
      ? {
          startsAt: String(row.event_starts_at),
          endsAt: row.event_ends_at ? String(row.event_ends_at) : null,
          location: row.event_location ? String(row.event_location) : null,
          rsvpEnabled: Number(row.rsvp_enabled) === 1,
        }
      : null,
    status: String(row.status),
    deleted: !!row.deleted_at,
    publishedAt: row.published_at ? String(row.published_at) : null,
    authorKind: memberAuthor ? 'member' : 'staff',
    authorId: row.author_id ? String(row.author_id) : null,
    authorName: row.author_first_name && memberAuthor
      ? `${String(row.author_first_name)} ${String(row.author_last_name ?? '')}`.trim()
      : row.author_user_name
        ? String(row.author_user_name)
        : null,
    authorAccountType: memberAuthor ? String(row.author_account_type ?? 'student') : 'staff',
    reviewNote: row.review_note ? String(row.review_note) : null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    notifiedAt: row.notified_at ? String(row.notified_at) : null,
    likeCount: Number(row.like_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    rsvpCount: Number(row.rsvp_count ?? 0),
    revisionCount: Number(row.revision_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function loadPost(ctx: Ctx, id: string, customerId: string, includeDeleted = false) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `${SELECT_POST} WHERE p.id = ? AND p.customer_id = ? ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}`,
    [id, customerId],
  );
  if (!row) throw notFound('That post no longer exists.');
  return row;
}

/** Staff posts may link a community-visible CRM event, or carry their own event details. */
async function parseAdminPost(ctx: Ctx, body: Record<string, unknown>, customerId: string) {
  const fields = await parsePostFields(ctx.db, customerId, body);
  const eventId = optionalId(body.eventId, 'Event');
  if (eventId) {
    const event = await ctx.db.get<{ community_visible: number }>(
      `SELECT community_visible FROM events WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [eventId, customerId],
    );
    if (!event) throw badRequest('That event was not found.', 'Event');
    if (Number(event.community_visible) !== 1) {
      throw badRequest('Mark that event "Show in the community portal" before linking it to a post.', 'Event');
    }
  }
  return { ...fields, eventId };
}

async function afterPublish(ctx: Ctx, auth: AuthContext, postId: string) {
  const mentions = await ctx.db.all<{ user_id: string }>(
    `SELECT user_id FROM post_mentions WHERE source_type = 'post' AND source_id = ?`,
    [postId],
  );
  const post = await ctx.db.get<{ author_id: string | null }>(`SELECT author_id FROM posts WHERE id = ?`, [postId]);
  await enqueueMentionNotifications(ctx.db, {
    customerId: auth.customerId,
    sourceType: 'post',
    sourceId: postId,
    actorId: post?.author_id ?? auth.userId,
    userIds: mentions.map((m) => m.user_id),
  });
}

export function register(router: Router): void {
  router.get('/api/admin/posts', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    const where = ['p.customer_id = ?', 'p.deleted_at IS NULL'];
    const params: SqlParam[] = [customerId];
    const status = ctx.query.get('status');
    if (status && status !== 'all') {
      where.push('p.status = ?');
      params.push(oneOf(status, 'Status', POST_STATUSES));
    }
    const author = ctx.query.get('author');
    if (author === 'member' || author === 'staff') {
      where.push('p.author_kind = ?');
      params.push(author);
    }
    const limit = positiveInt(ctx.query.get('limit'), 20, 100);
    const page = positiveInt(ctx.query.get('page'), 1, 1000);
    const total = await ctx.db.get<{ total: unknown }>(`SELECT COUNT(*) AS total FROM posts p WHERE ${where.join(' AND ')}`, params);
    const pending = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM posts WHERE customer_id = ? AND status = 'pending' AND deleted_at IS NULL`,
      [customerId],
    );
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${SELECT_POST} WHERE ${where.join(' AND ')}
        ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END,
                 COALESCE(p.published_at, p.updated_at) DESC, p.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    return jsonResponse({
      posts: await Promise.all(rows.map((row) => adminPostOut(ctx, row))),
      page,
      limit,
      total: Number(total?.total ?? 0),
      pendingCount: Number(pending?.total ?? 0),
    });
  });

  /**
   * Content history for Admin > Settings: every edit, takedown, restore and
   * review decision on posts (with the previous content), plus removed comments.
   */
  router.get('/api/admin/posts/history', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    const limit = positiveInt(ctx.query.get('limit'), 50, 200);
    const revisions = await ctx.db.all<Record<string, unknown>>(
      `SELECT pr.*, u.name AS changed_by_name, p.title AS current_title, p.deleted_at AS post_deleted_at, p.status AS current_status
         FROM post_revisions pr
         LEFT JOIN users u ON u.id = pr.changed_by
         LEFT JOIN posts p ON p.id = pr.post_id
        WHERE pr.customer_id = ?
        ORDER BY pr.created_at DESC LIMIT ?`,
      [customerId, limit],
    );
    const comments = await ctx.db.all<Record<string, unknown>>(
      `SELECT c.id, c.body, c.created_at, c.deleted_at, c.post_id, p.title AS post_title,
              author.name AS author_name, remover.name AS removed_by_name
         FROM post_comments c
         JOIN posts p ON p.id = c.post_id
         LEFT JOIN users author ON author.id = c.user_id
         LEFT JOIN users remover ON remover.id = c.deleted_by
        WHERE c.customer_id = ? AND c.deleted_at IS NOT NULL
        ORDER BY c.deleted_at DESC LIMIT ?`,
      [customerId, limit],
    );
    return jsonResponse({
      revisions: revisions.map((row) => ({
        id: String(row.id),
        postId: String(row.post_id),
        action: String(row.action),
        previous: {
          title: String(row.title),
          body: String(row.body),
          linkUrl: row.link_url ? String(row.link_url) : null,
          status: String(row.status),
          eventStartsAt: row.event_starts_at ? String(row.event_starts_at) : null,
          eventLocation: row.event_location ? String(row.event_location) : null,
        },
        currentTitle: row.current_title ? String(row.current_title) : null,
        currentStatus: row.current_status ? String(row.current_status) : null,
        postDeleted: !!row.post_deleted_at,
        changedByName: row.changed_by_name ? String(row.changed_by_name) : null,
        createdAt: String(row.created_at),
      })),
      removedComments: comments.map((row) => ({
        id: String(row.id),
        postId: String(row.post_id),
        postTitle: String(row.post_title),
        body: String(row.body),
        authorName: row.author_name ? String(row.author_name) : null,
        removedByName: row.removed_by_name ? String(row.removed_by_name) : null,
        createdAt: String(row.created_at),
        removedAt: String(row.deleted_at),
      })),
    });
  });

  router.get('/api/admin/posts/:id', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    const row = await loadPost(ctx, ctx.params.id!, customerId, true);
    const rsvps = await ctx.db.all<{ name: string; account_type: string }>(
      `SELECT COALESCE(cp.first_name || ' ' || cp.last_name, u.name) AS name, ca.account_type
         FROM event_rsvps r JOIN users u ON u.id = r.user_id
         LEFT JOIN community_profiles cp ON cp.user_id = r.user_id
         LEFT JOIN community_accounts ca ON ca.user_id = r.user_id
        WHERE r.target_type = 'post' AND r.target_id = ? ORDER BY name ASC`,
      [ctx.params.id!],
    );
    return jsonResponse({
      post: await adminPostOut(ctx, row),
      rsvps: rsvps.map((r) => ({ name: r.name, accountType: r.account_type })),
    });
  });

  router.post('/api/admin/posts', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const fields = await parseAdminPost(ctx, body, auth.customerId);
    const publish = body.publish === true;
    const id = newId();
    const timestamp = nowIso();
    await ctx.db.run(
      `INSERT INTO posts (id, customer_id, title, body, link_url, event_id, status, published_at, author_id, author_kind,
                          event_starts_at, event_ends_at, event_location, rsvp_enabled,
                          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.customerId, fields.title, fields.body, fields.linkUrl, fields.eventId,
        publish ? 'published' : 'draft', publish ? timestamp : null, auth.userId,
        fields.eventStartsAt, fields.eventEndsAt, fields.eventLocation, fields.rsvpEnabled,
        timestamp, timestamp, auth.userId, auth.userId,
      ],
    );
    await recordMentions(ctx.db, { customerId: auth.customerId, sourceType: 'post', sourceId: id, userIds: fields.mentionIds });
    if (publish) await afterPublish(ctx, auth, id);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: publish ? 'post.publish' : 'post.create',
      entityType: 'post',
      entityId: id,
      metadata: { title: fields.title },
      req: ctx.req,
    });
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, id, auth.customerId)) }, { status: 201 });
  });

  /** Staff edits (including of member posts) keep the post's status; the previous version is logged. */
  router.put('/api/admin/posts/:id', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth.customerId);
    const fields = await parseAdminPost(ctx, await readJson(ctx.req), auth.customerId);
    await recordRevision(ctx.db, { postId: ctx.params.id!, action: 'edit', changedBy: auth.userId });
    await ctx.db.run(
      `UPDATE posts SET title = ?, body = ?, link_url = ?, event_id = ?, event_starts_at = ?, event_ends_at = ?,
              event_location = ?, rsvp_enabled = ?, updated_at = ?, last_edited_by = ?
        WHERE id = ? AND customer_id = ?`,
      [
        fields.title, fields.body, fields.linkUrl, fields.eventId, fields.eventStartsAt, fields.eventEndsAt,
        fields.eventLocation, fields.rsvpEnabled, nowIso(), auth.userId, ctx.params.id!, auth.customerId,
      ],
    );
    await recordMentions(ctx.db, { customerId: auth.customerId, sourceType: 'post', sourceId: ctx.params.id!, userIds: fields.mentionIds });
    if (String(existing.status) === 'published') await afterPublish(ctx, auth, ctx.params.id!);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'post.update',
      entityType: 'post',
      entityId: ctx.params.id!,
      metadata: { title: fields.title },
      req: ctx.req,
    });
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, auth.customerId)) });
  });

  const transition = (path: string, to: 'published' | 'draft' | 'archived', action: AuditAction) =>
    router.post(`/api/admin/posts/:id/${path}`, async (ctx: Ctx) => {
      const auth = requireEditor(ctx);
      const existing = await loadPost(ctx, ctx.params.id!, auth.customerId);
      const timestamp = nowIso();
      // Publishing stamps the publication time the first time only, so a
      // re-publish keeps its place in the feed rather than jumping to the top.
      await ctx.db.run(
        `UPDATE posts SET status = ?,
                published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
                updated_at = ?, last_edited_by = ?
          WHERE id = ? AND customer_id = ?`,
        [to, to, timestamp, timestamp, auth.userId, ctx.params.id!, auth.customerId],
      );
      if (to === 'published') await afterPublish(ctx, auth, ctx.params.id!);
      await audit(ctx.db, {
        customerId: auth.customerId,
        userId: auth.userId,
        action,
        entityType: 'post',
        entityId: ctx.params.id!,
        metadata: { title: String(existing.title), from: String(existing.status) },
        req: ctx.req,
      });
      return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, auth.customerId)) });
    });
  transition('publish', 'published', 'post.publish');
  transition('unpublish', 'draft', 'post.unpublish');
  transition('archive', 'archived', 'post.archive');

  /** Approve a member submission: it goes live in the feed. */
  router.post('/api/admin/posts/:id/approve', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth.customerId);
    if (String(existing.status) !== 'pending') throw badRequest('Only posts awaiting approval can be approved.');
    await recordRevision(ctx.db, { postId: ctx.params.id!, action: 'approve', changedBy: auth.userId });
    const timestamp = nowIso();
    await ctx.db.run(
      `UPDATE posts SET status = 'published', published_at = COALESCE(published_at, ?), review_note = NULL,
              reviewed_by = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
      [timestamp, auth.userId, timestamp, timestamp, ctx.params.id!],
    );
    await afterPublish(ctx, auth, ctx.params.id!);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'post.approve',
      entityType: 'post',
      entityId: ctx.params.id!,
      metadata: { title: String(existing.title) },
      req: ctx.req,
    });
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, auth.customerId)) });
  });

  /** Reject a member submission with an optional note the author can see. */
  router.post('/api/admin/posts/:id/reject', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth.customerId);
    if (String(existing.status) !== 'pending') throw badRequest('Only posts awaiting approval can be rejected.');
    const note = optionalString((await readJson(ctx.req)).note, 'Note', { max: 500 });
    await recordRevision(ctx.db, { postId: ctx.params.id!, action: 'reject', changedBy: auth.userId });
    const timestamp = nowIso();
    await ctx.db.run(
      `UPDATE posts SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
      [note, auth.userId, timestamp, timestamp, ctx.params.id!],
    );
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'post.reject',
      entityType: 'post',
      entityId: ctx.params.id!,
      metadata: { title: String(existing.title), note },
      req: ctx.req,
    });
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, auth.customerId)) });
  });

  /** Take a post down (soft delete). It stays in the history log and can be restored. */
  router.delete('/api/admin/posts/:id', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth.customerId);
    await recordRevision(ctx.db, { postId: ctx.params.id!, action: 'delete', changedBy: auth.userId });
    const timestamp = nowIso();
    await ctx.db.run(`UPDATE posts SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?`, [
      timestamp, auth.userId, timestamp, ctx.params.id!,
    ]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'post.delete',
      entityType: 'post',
      entityId: ctx.params.id!,
      metadata: { title: String(existing.title) },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });

  router.post('/api/admin/posts/:id/restore', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth.customerId, true);
    if (!existing.deleted_at) throw badRequest('That post has not been removed.');
    await ctx.db.run(`UPDATE posts SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?`, [
      nowIso(), ctx.params.id!,
    ]);
    await recordRevision(ctx.db, { postId: ctx.params.id!, action: 'restore', changedBy: auth.userId });
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'post.restore',
      entityType: 'post',
      entityId: ctx.params.id!,
      metadata: { title: String(existing.title) },
      req: ctx.req,
    });
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, auth.customerId)) });
  });

  /**
   * Email every opted-in member about a published post. Queued through the
   * outbox; calling it twice never sends twice.
   */
  router.post('/api/admin/posts/:id/notify', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, auth.customerId);
    if (String(existing.status) !== 'published') throw badRequest('Publish the post before emailing members about it.');
    const queued = await enqueueAnnouncement(ctx.db, {
      customerId: auth.customerId,
      refType: 'post',
      refId: ctx.params.id!,
      actorId: auth.userId,
    });
    await ctx.db.run(`UPDATE posts SET notified_at = COALESCE(notified_at, ?) WHERE id = ?`, [nowIso(), ctx.params.id!]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'post.notify',
      entityType: 'post',
      entityId: ctx.params.id!,
      metadata: { title: String(existing.title), recipients: queued },
      req: ctx.req,
    });
    return jsonResponse({ queued, post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, auth.customerId)) });
  });

  router.post('/api/admin/posts/:id/image', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, customerId);
    const stored = await storeCommunityUpload(ctx, { purpose: 'post-image', customerId, ownerId: ctx.params.id! });
    await ctx.db.run(
      `UPDATE posts SET image_key = ?, image_type = ?, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
      [stored.key, stored.type, nowIso(), userId, ctx.params.id!, customerId],
    );
    if (existing.image_key) await deleteObject(ctx.env.DOCS, String(existing.image_key)).catch(() => undefined);
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, customerId)) });
  });

  router.delete('/api/admin/posts/:id/image', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await loadPost(ctx, ctx.params.id!, customerId);
    await ctx.db.run(
      `UPDATE posts SET image_key = NULL, image_type = NULL, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
      [nowIso(), userId, ctx.params.id!, customerId],
    );
    if (existing.image_key) await deleteObject(ctx.env.DOCS, String(existing.image_key)).catch(() => undefined);
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, customerId)) });
  });
}
