import type { SqlParam } from '../db/driver.ts';
import type { AuditAction } from '../lib/audit.ts';
import { audit } from '../lib/audit.ts';
import { optionalWebLink } from '../lib/communityValidate.ts';
import { badRequest, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, optionalId, positiveInt, requiredString } from '../lib/validate.ts';
import { requireEditor, requireStaff } from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';
import { storeCommunityUpload } from '../services/communityFiles.ts';
import { deleteObject } from '../services/storage.ts';
import { postImageUrl } from './communityContent.ts';

/**
 * Admin-authored community feed. Owners and editors create, edit, publish,
 * unpublish and archive; viewers may read (the existing read-only staff role);
 * community members are refused outright by requireStaff.
 */

const POST_STATUSES = ['draft', 'published', 'archived'] as const;

const SELECT_POST = `
  SELECT p.*, u.name AS author_name, e.name AS event_name, e.starts_at AS event_starts_at,
         e.community_visible AS event_community_visible
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN events e ON e.id = p.event_id AND e.deleted_at IS NULL`;

async function adminPostOut(ctx: Ctx, row: Record<string, unknown>) {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    linkUrl: row.link_url ? String(row.link_url) : null,
    imageUrl: await postImageUrl(ctx, String(row.id), row.image_key, 'staff'),
    eventId: row.event_id ? String(row.event_id) : null,
    eventName: row.event_name ? String(row.event_name) : null,
    eventStartsAt: row.event_starts_at ? String(row.event_starts_at) : null,
    eventCommunityVisible: Number(row.event_community_visible ?? 0) === 1,
    status: String(row.status),
    publishedAt: row.published_at ? String(row.published_at) : null,
    authorName: row.author_name ? String(row.author_name) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function parsePost(ctx: Ctx, body: Record<string, unknown>, customerId: string) {
  const eventId = optionalId(body.eventId, 'Event');
  if (eventId) {
    const event = await ctx.db.get<{ community_visible: number }>(
      `SELECT community_visible FROM events WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [eventId, customerId],
    );
    if (!event) throw badRequest('That event was not found.', 'Event');
    if (Number(event.community_visible) !== 1) {
      throw badRequest('Mark that event "Show in community portal" before linking it to a post.', 'Event');
    }
  }
  return {
    title: requiredString(body.title, 'Title', { max: 200 }),
    body: requiredString(body.body, 'Body', { max: 10000 }),
    linkUrl: optionalWebLink(body.linkUrl),
    eventId,
  };
}

async function loadPost(ctx: Ctx, id: string, customerId: string) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `${SELECT_POST} WHERE p.id = ? AND p.customer_id = ? AND p.deleted_at IS NULL`,
    [id, customerId],
  );
  if (!row) throw notFound('That post no longer exists.');
  return row;
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
    const limit = positiveInt(ctx.query.get('limit'), 20, 100);
    const page = positiveInt(ctx.query.get('page'), 1, 1000);
    const total = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM posts p WHERE ${where.join(' AND ')}`,
      params,
    );
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${SELECT_POST} WHERE ${where.join(' AND ')}
        ORDER BY CASE p.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
                 COALESCE(p.published_at, p.updated_at) DESC, p.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    return jsonResponse({
      posts: await Promise.all(rows.map((row) => adminPostOut(ctx, row))),
      page,
      limit,
      total: Number(total?.total ?? 0),
    });
  });

  router.get('/api/admin/posts/:id', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, customerId)) });
  });

  router.post('/api/admin/posts', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const fields = await parsePost(ctx, body, customerId);
    const publish = body.publish === true;
    const id = newId();
    const timestamp = nowIso();
    await ctx.db.run(
      `INSERT INTO posts (id, customer_id, title, body, link_url, event_id, status, published_at, author_id,
                          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId,
        fields.title,
        fields.body,
        fields.linkUrl,
        fields.eventId,
        publish ? 'published' : 'draft',
        publish ? timestamp : null,
        userId,
        timestamp,
        timestamp,
        userId,
        userId,
      ],
    );
    await audit(ctx.db, {
      customerId,
      userId,
      action: publish ? 'post.publish' : 'post.create',
      entityType: 'post',
      entityId: id,
      metadata: { title: fields.title },
      req: ctx.req,
    });
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, id, customerId)) }, { status: 201 });
  });

  router.put('/api/admin/posts/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    await loadPost(ctx, ctx.params.id!, customerId);
    const fields = await parsePost(ctx, await readJson(ctx.req), customerId);
    await ctx.db.run(
      `UPDATE posts SET title = ?, body = ?, link_url = ?, event_id = ?, updated_at = ?, last_edited_by = ?
        WHERE id = ? AND customer_id = ?`,
      [fields.title, fields.body, fields.linkUrl, fields.eventId, nowIso(), userId, ctx.params.id!, customerId],
    );
    await audit(ctx.db, {
      customerId,
      userId,
      action: 'post.update',
      entityType: 'post',
      entityId: ctx.params.id!,
      metadata: { title: fields.title },
      req: ctx.req,
    });
    return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, customerId)) });
  });

  const transition = (path: string, to: 'published' | 'draft' | 'archived', action: AuditAction) =>
    router.post(`/api/admin/posts/:id/${path}`, async (ctx: Ctx) => {
      const { customerId, userId } = requireEditor(ctx);
      const existing = await loadPost(ctx, ctx.params.id!, customerId);
      const timestamp = nowIso();
      // Publishing stamps the publication time the first time only, so a
      // re-publish keeps its place in the feed rather than jumping to the top.
      await ctx.db.run(
        `UPDATE posts SET status = ?,
                published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
                updated_at = ?, last_edited_by = ?
          WHERE id = ? AND customer_id = ?`,
        [to, to, timestamp, timestamp, userId, ctx.params.id!, customerId],
      );
      await audit(ctx.db, {
        customerId,
        userId,
        action,
        entityType: 'post',
        entityId: ctx.params.id!,
        metadata: { title: String(existing.title), from: String(existing.status) },
        req: ctx.req,
      });
      return jsonResponse({ post: await adminPostOut(ctx, await loadPost(ctx, ctx.params.id!, customerId)) });
    });
  transition('publish', 'published', 'post.publish');
  transition('unpublish', 'draft', 'post.unpublish');
  transition('archive', 'archived', 'post.archive');

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
