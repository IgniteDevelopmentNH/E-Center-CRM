import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { optionalWebLink } from '../lib/communityValidate.ts';
import { badRequest, jsonResponse, notFound, readJson, unauthorized } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { signValue, verifyValue } from '../lib/signedToken.ts';
import { nowIso } from '../lib/time.ts';
import { optionalString, requiredString, requiredTimestamp } from '../lib/validate.ts';
import { requireCommunityViewer, requireEditor, requireStaff } from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';
import { storeCommunityUpload } from '../services/communityFiles.ts';
import { deleteObject, readObject } from '../services/storage.ts';
import { fileResponse } from './communityContent.ts';

/**
 * ECenter competitions. Staff (owners/editors) post them from Admin >
 * Competitions; members and guests see published ones. Each competition has
 * one or more deadlines, and every upcoming deadline is also listed in
 * Upcoming events (see upcomingEvents in communityPosts.ts).
 */

const MAX_DEADLINES = 10;
const IMAGE_TTL_SECONDS = 60 * 60 * 6;

async function imageUrl(ctx: Ctx, id: string, key: unknown, scope: 'staff' | 'community'): Promise<string | null> {
  if (!key) return null;
  const token = await signValue({ k: 'competition', i: id, s: scope }, ctx.config.tokenSecret, IMAGE_TTL_SECONDS);
  return `/api/community/files/competition/${id}?token=${encodeURIComponent(token)}`;
}

export async function competitionOut(ctx: Ctx, row: Record<string, unknown>, scope: 'staff' | 'community') {
  const id = String(row.id);
  const deadlines = await ctx.db.all<{ id: string; label: string; due_at: string }>(
    `SELECT id, label, due_at FROM competition_deadlines WHERE competition_id = ? ORDER BY due_at ASC`,
    [id],
  );
  const now = nowIso();
  const next = deadlines.find((d) => d.due_at >= now) ?? null;
  return {
    id,
    title: String(row.title),
    summary: row.summary ? String(row.summary) : null,
    description: row.description ? String(row.description) : null,
    prize: row.prize ? String(row.prize) : null,
    eligibility: row.eligibility ? String(row.eligibility) : null,
    linkUrl: row.link_url ? String(row.link_url) : null,
    imageUrl: await imageUrl(ctx, id, row.image_key, scope),
    status: String(row.status) as 'draft' | 'published' | 'archived',
    publishedAt: row.published_at ? String(row.published_at) : null,
    deadlines: deadlines.map((d) => ({ id: d.id, label: d.label, dueAt: d.due_at, passed: d.due_at < now })),
    nextDeadline: next ? { id: next.id, label: next.label, dueAt: next.due_at } : null,
    updatedAt: String(row.updated_at),
  };
}

/** Published competitions: open ones (by next deadline) first, then past ones. */
export async function listPublishedCompetitions(ctx: Ctx, customerId: string) {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT c.*,
            (SELECT MIN(d.due_at) FROM competition_deadlines d WHERE d.competition_id = c.id AND d.due_at >= ?) AS next_due
       FROM competitions c
      WHERE c.customer_id = ? AND c.status = 'published' AND c.deleted_at IS NULL
      ORDER BY CASE WHEN next_due IS NULL THEN 1 ELSE 0 END, next_due ASC, c.published_at DESC
      LIMIT 100`,
    [nowIso(), customerId],
  );
  return Promise.all(rows.map((row) => competitionOut(ctx, row, 'community')));
}

export async function loadPublishedCompetition(ctx: Ctx, customerId: string, id: string) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `SELECT * FROM competitions WHERE id = ? AND customer_id = ? AND status = 'published' AND deleted_at IS NULL`,
    [id, customerId],
  );
  if (!row) throw notFound('That competition is not available.');
  return competitionOut(ctx, row, 'community');
}

function parseCompetition(body: Record<string, unknown>) {
  const raw = Array.isArray(body.deadlines) ? (body.deadlines as unknown[]) : [];
  if (raw.length > MAX_DEADLINES) throw badRequest(`Add up to ${MAX_DEADLINES} deadlines.`, 'Deadlines');
  const deadlines = raw.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return {
      label: optionalString(item.label, 'Deadline name', { max: 120 }) ?? 'Deadline',
      dueAt: requiredTimestamp(item.dueAt, 'Deadline date'),
    };
  });
  return {
    title: requiredString(body.title, 'Title', { max: 200 }),
    summary: optionalString(body.summary, 'Summary', { max: 300 }),
    description: optionalString(body.description, 'Details', { max: 10000 }),
    prize: optionalString(body.prize, 'Prize', { max: 300 }),
    eligibility: optionalString(body.eligibility, 'Who can enter', { max: 1000 }),
    linkUrl: optionalWebLink(body.linkUrl, 'Application link'),
    deadlines,
  };
}

function deadlineWrites(competitionId: string, customerId: string, deadlines: { label: string; dueAt: string }[]) {
  const timestamp = nowIso();
  return [
    { sql: `DELETE FROM competition_deadlines WHERE competition_id = ?`, params: [competitionId] as SqlParam[] },
    ...deadlines.map((d) => ({
      sql: `INSERT INTO competition_deadlines (id, competition_id, customer_id, label, due_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [newId(), competitionId, customerId, d.label, d.dueAt, timestamp] as SqlParam[],
    })),
  ];
}

async function loadAny(ctx: Ctx, id: string, customerId: string) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `SELECT * FROM competitions WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
    [id, customerId],
  );
  if (!row) throw notFound('That competition no longer exists.');
  return row;
}

export function register(router: Router): void {
  /* -------------------------------------------------- community -- */

  router.get('/api/community/competitions', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    return jsonResponse({ competitions: await listPublishedCompetitions(ctx, auth.customerId) });
  });

  router.get('/api/community/competitions/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    return jsonResponse({ competition: await loadPublishedCompetition(ctx, auth.customerId, ctx.params.id!) });
  });

  router.get('/api/community/files/competition/:id', async (ctx: Ctx) => {
    const payload = await verifyValue(ctx.query.get('token') ?? '', ctx.config.tokenSecret);
    if (!payload || payload.k !== 'competition' || payload.i !== ctx.params.id) throw unauthorized('That link has expired.');
    const row = await ctx.db.get<{ image_key: string | null; image_type: string | null; status: string }>(
      `SELECT image_key, image_type, status FROM competitions WHERE id = ? AND deleted_at IS NULL`,
      [ctx.params.id!],
    );
    if (!row?.image_key || (payload.s !== 'staff' && row.status !== 'published')) throw notFound();
    const stored = await readObject(ctx.env.DOCS, row.image_key, ctx.config.encryptionKey);
    return fileResponse(stored.body, stored.contentType ?? row.image_type ?? 'image/jpeg', 'inline');
  });

  /* ------------------------------------------------------ admin -- */

  router.get('/api/admin/competitions', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    const rows = await ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM competitions WHERE customer_id = ? AND deleted_at IS NULL
        ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, updated_at DESC
        LIMIT 200`,
      [customerId],
    );
    return jsonResponse({ competitions: await Promise.all(rows.map((row) => competitionOut(ctx, row, 'staff'))) });
  });

  router.get('/api/admin/competitions/:id', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    return jsonResponse({ competition: await competitionOut(ctx, await loadAny(ctx, ctx.params.id!, customerId), 'staff') });
  });

  router.post('/api/admin/competitions', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const fields = parseCompetition(body);
    const publish = body.publish === true;
    const id = newId();
    const timestamp = nowIso();
    await ctx.db.batch([
      {
        sql: `INSERT INTO competitions (id, customer_id, title, summary, description, prize, eligibility, link_url,
                                        status, published_at, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id, auth.customerId, fields.title, fields.summary, fields.description, fields.prize, fields.eligibility,
          fields.linkUrl, publish ? 'published' : 'draft', publish ? timestamp : null, auth.userId, timestamp, timestamp,
        ],
      },
      ...deadlineWrites(id, auth.customerId, fields.deadlines),
    ]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'competition.create',
      entityType: 'competition',
      entityId: id,
      metadata: { title: fields.title, published: publish },
      req: ctx.req,
    });
    return jsonResponse({ competition: await competitionOut(ctx, await loadAny(ctx, id, auth.customerId), 'staff') }, { status: 201 });
  });

  router.put('/api/admin/competitions/:id', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadAny(ctx, ctx.params.id!, auth.customerId);
    const fields = parseCompetition(await readJson(ctx.req));
    await ctx.db.batch([
      {
        sql: `UPDATE competitions SET title = ?, summary = ?, description = ?, prize = ?, eligibility = ?, link_url = ?,
                updated_at = ? WHERE id = ?`,
        params: [
          fields.title, fields.summary, fields.description, fields.prize, fields.eligibility, fields.linkUrl,
          nowIso(), String(existing.id),
        ],
      },
      ...deadlineWrites(String(existing.id), auth.customerId, fields.deadlines),
    ]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'competition.update',
      entityType: 'competition',
      entityId: String(existing.id),
      metadata: { title: fields.title },
      req: ctx.req,
    });
    return jsonResponse({ competition: await competitionOut(ctx, await loadAny(ctx, String(existing.id), auth.customerId), 'staff') });
  });

  const transition = (path: string, to: 'published' | 'draft' | 'archived') =>
    router.post(`/api/admin/competitions/:id/${path}`, async (ctx: Ctx) => {
      const auth = requireEditor(ctx);
      const existing = await loadAny(ctx, ctx.params.id!, auth.customerId);
      const timestamp = nowIso();
      await ctx.db.run(
        `UPDATE competitions SET status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
                updated_at = ? WHERE id = ?`,
        [to, to, timestamp, timestamp, String(existing.id)],
      );
      await audit(ctx.db, {
        customerId: auth.customerId,
        userId: auth.userId,
        action: 'competition.update',
        entityType: 'competition',
        entityId: String(existing.id),
        metadata: { title: String(existing.title), status: to },
        req: ctx.req,
      });
      return jsonResponse({ competition: await competitionOut(ctx, await loadAny(ctx, String(existing.id), auth.customerId), 'staff') });
    });
  transition('publish', 'published');
  transition('unpublish', 'draft');
  transition('archive', 'archived');

  router.delete('/api/admin/competitions/:id', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadAny(ctx, ctx.params.id!, auth.customerId);
    const timestamp = nowIso();
    await ctx.db.run(`UPDATE competitions SET deleted_at = ?, updated_at = ? WHERE id = ?`, [timestamp, timestamp, String(existing.id)]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'competition.delete',
      entityType: 'competition',
      entityId: String(existing.id),
      metadata: { title: String(existing.title) },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });

  router.post('/api/admin/competitions/:id/image', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadAny(ctx, ctx.params.id!, auth.customerId);
    const stored = await storeCommunityUpload(ctx, {
      purpose: 'competition-image',
      customerId: auth.customerId,
      ownerId: String(existing.id),
    });
    await ctx.db.run(`UPDATE competitions SET image_key = ?, image_type = ?, updated_at = ? WHERE id = ?`, [
      stored.key, stored.type, nowIso(), String(existing.id),
    ]);
    if (existing.image_key) await deleteObject(ctx.env.DOCS, String(existing.image_key)).catch(() => undefined);
    return jsonResponse({ competition: await competitionOut(ctx, await loadAny(ctx, String(existing.id), auth.customerId), 'staff') });
  });

  router.delete('/api/admin/competitions/:id/image', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const existing = await loadAny(ctx, ctx.params.id!, auth.customerId);
    await ctx.db.run(`UPDATE competitions SET image_key = NULL, image_type = NULL, updated_at = ? WHERE id = ?`, [
      nowIso(), String(existing.id),
    ]);
    if (existing.image_key) await deleteObject(ctx.env.DOCS, String(existing.image_key)).catch(() => undefined);
    return jsonResponse({ competition: await competitionOut(ctx, await loadAny(ctx, String(existing.id), auth.customerId), 'staff') });
  });
}
