import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, jsonResponse, notFound, unauthorized } from '../lib/http.ts';
import { signValue, verifyValue } from '../lib/signedToken.ts';
import { positiveInt } from '../lib/validate.ts';
import { requireCommunityViewer } from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';
import { PUBLIC_PROFILE_COLUMNS, loadTags, publicMemberOut } from '../services/community.ts';
import { recommendMentors } from '../services/matching.ts';
import { readObject } from '../services/storage.ts';

/**
 * Read-only community content. Every route here requires an ACTIVE community
 * member (or staff). Responses are built from explicit allow-lists of public
 * columns -- no CRM table is read except `events`, and only rows staff have
 * flagged community_visible, through their public columns.
 */

/** Shared directory query: active, onboarded members only, public columns only. */
function directoryWhere(ctx: Ctx, customerId: string, viewerId: string) {
  const where: string[] = [
    'ca.customer_id = ?',
    `ca.status = 'active'`,
    'ca.onboarding_completed_at IS NOT NULL',
    'u.deleted_at IS NULL',
    'ca.user_id <> ?',
  ];
  const params: SqlParam[] = [customerId, viewerId];

  const type = ctx.query.get('type');
  if (type && type !== 'all') {
    if (!['student', 'mentor', 'staff'].includes(type)) throw badRequest('Unknown member type.', 'Type');
    where.push('ca.account_type = ?');
    params.push(type);
  }

  const tag = ctx.query.get('tag');
  if (tag && tag !== 'all') {
    where.push(
      `EXISTS (SELECT 1 FROM community_profile_tags pt JOIN interest_tags t ON t.id = pt.tag_id
                WHERE pt.user_id = ca.user_id AND t.slug = ?)`,
    );
    params.push(tag.slice(0, 80));
  }

  const q = (ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 100);
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(LOWER(p.first_name || ' ' || p.last_name) LIKE ? OR LOWER(COALESCE(p.bio, '')) LIKE ?
        OR LOWER(COALESCE(p.role_title, '')) LIKE ? OR LOWER(COALESCE(p.company, '')) LIKE ?
        OR LOWER(COALESCE(p.major, '')) LIKE ?
        OR EXISTS (SELECT 1 FROM community_profile_tags pt JOIN interest_tags t ON t.id = pt.tag_id
                    WHERE pt.user_id = ca.user_id AND LOWER(t.label) LIKE ?))`,
    );
    params.push(like, like, like, like, like, like);
  }
  return { clause: where.join(' AND '), params };
}

const DIRECTORY_FROM = `
  FROM community_accounts ca
  JOIN users u ON u.id = ca.user_id
  JOIN community_profiles p ON p.user_id = ca.user_id`;

async function listMembers(ctx: Ctx, customerId: string, viewerId: string) {
  const { clause, params } = directoryWhere(ctx, customerId, viewerId);
  const limit = positiveInt(ctx.query.get('limit'), 24, 60);
  const page = positiveInt(ctx.query.get('page'), 1, 1000);
  const total = await ctx.db.get<{ total: unknown }>(`SELECT COUNT(*) AS total ${DIRECTORY_FROM} WHERE ${clause}`, params);
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT ${PUBLIC_PROFILE_COLUMNS} ${DIRECTORY_FROM} WHERE ${clause}
      ORDER BY LOWER(p.last_name) ASC, LOWER(p.first_name) ASC, ca.user_id ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  const tags = await loadTags(ctx.db, rows.map((r) => String(r.user_id)));
  const members = await Promise.all(rows.map((row) => publicMemberOut(ctx, row, tags.get(String(row.user_id)))));
  const count = Number(total?.total ?? 0);
  return { members, page, limit, total: count, hasMore: page * limit < count };
}

export function fileResponse(body: ArrayBuffer, type: string, disposition: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

export function register(router: Router): void {
  router.get('/api/community/members', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    return jsonResponse(await listMembers(ctx, auth.customerId, auth.userId));
  });

  router.get('/api/community/members/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await ctx.db.get<Record<string, unknown>>(
      `SELECT ${PUBLIC_PROFILE_COLUMNS} ${DIRECTORY_FROM}
        WHERE ca.user_id = ? AND ca.customer_id = ? AND u.deleted_at IS NULL
          AND ((ca.status = 'active' AND ca.onboarding_completed_at IS NOT NULL) OR ca.user_id = ?)`,
      [ctx.params.id!, auth.customerId, auth.userId],
    );
    if (!row) throw notFound('That member profile is not available.');
    const tags = await loadTags(ctx.db, [String(row.user_id)]);
    return jsonResponse({ member: await publicMemberOut(ctx, row, tags.get(String(row.user_id))) });
  });

  /** A member's resume, only when they have chosen to make it public. */
  router.get('/api/community/members/:id/resume', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await ctx.db.get<{ resume_key: string | null }>(
      `SELECT ca.resume_key FROM community_accounts ca JOIN users u ON u.id = ca.user_id
        WHERE ca.user_id = ? AND ca.customer_id = ? AND ca.status = 'active' AND ca.resume_public = 1
          AND u.deleted_at IS NULL`,
      [ctx.params.id!, auth.customerId],
    );
    if (!row?.resume_key) throw notFound('That resume is not available.');
    const token = await signValue({ k: 'resume', u: ctx.params.id! }, ctx.config.tokenSecret, ctx.config.downloadUrlTtlSeconds);
    return jsonResponse({ url: `/api/community/files/resume/${ctx.params.id!}?token=${encodeURIComponent(token)}` });
  });

  /** Browse all active mentors (search + tag filter). */
  router.get('/api/community/mentors', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    ctx.query.set('type', 'mentor');
    return jsonResponse(await listMembers(ctx, auth.customerId, auth.userId));
  });

  /** Explainable recommendations from shared public tags. Never claims a match without overlap. */
  router.get('/api/community/mentors/recommended', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const viewerTags = (await loadTags(ctx.db, [auth.userId])).get(auth.userId) ?? { interests: [], help: [] };
    if (!viewerTags.interests.length && !viewerTags.help.length) {
      return jsonResponse({ recommendations: [], needsTags: true });
    }

    const rows = await ctx.db.all<Record<string, unknown>>(
      `SELECT ${PUBLIC_PROFILE_COLUMNS} ${DIRECTORY_FROM}
        WHERE ca.customer_id = ? AND ca.account_type = 'mentor' AND ca.status = 'active'
          AND ca.onboarding_completed_at IS NOT NULL AND u.deleted_at IS NULL AND ca.user_id <> ?
        LIMIT 2000`,
      [auth.customerId, auth.userId],
    );
    const tags = await loadTags(ctx.db, rows.map((r) => String(r.user_id)));
    const ranked = recommendMentors(
      { id: auth.userId, ...viewerTags },
      rows.map((row) => ({
        id: String(row.user_id),
        firstName: String(row.first_name),
        lastName: String(row.last_name),
        interests: tags.get(String(row.user_id))?.interests ?? [],
        help: tags.get(String(row.user_id))?.help ?? [],
      })),
    );
    const byId = new Map(rows.map((row) => [String(row.user_id), row]));
    const recommendations = await Promise.all(
      ranked.map(async (match) => ({
        mentor: await publicMemberOut(ctx, byId.get(match.id)!, tags.get(match.id)),
        reason: match.reason,
        sharedTags: [...match.helpMatches, ...match.interestMatches],
      })),
    );
    return jsonResponse({ recommendations, needsTags: false });
  });

  /* ------------------------------------------------------- file serving -- */

  router.get('/api/community/files/photo/:userId', async (ctx: Ctx) => {
    const payload = await verifyValue(ctx.query.get('token') ?? '', ctx.config.tokenSecret);
    if (!payload || payload.k !== 'photo' || payload.u !== ctx.params.userId) throw unauthorized('That link has expired.');
    const row = await ctx.db.get<{ photo_key: string | null; photo_type: string | null }>(
      `SELECT p.photo_key, p.photo_type FROM community_profiles p
         JOIN community_accounts ca ON ca.user_id = p.user_id
        WHERE p.user_id = ? AND ca.status <> 'deactivated'`,
      [ctx.params.userId!],
    );
    if (!row?.photo_key) throw notFound();
    const stored = await readObject(ctx.env.DOCS, row.photo_key, ctx.config.encryptionKey);
    return fileResponse(stored.body, stored.contentType ?? row.photo_type ?? 'image/jpeg', 'inline');
  });

  router.get('/api/community/files/post-image/:postId', async (ctx: Ctx) => {
    const payload = await verifyValue(ctx.query.get('token') ?? '', ctx.config.tokenSecret);
    if (!payload || payload.k !== 'post' || payload.p !== ctx.params.postId) throw unauthorized('That link has expired.');
    const row = await ctx.db.get<{ image_key: string | null; image_type: string | null; status: string }>(
      `SELECT image_key, image_type, status FROM posts WHERE id = ? AND deleted_at IS NULL`,
      [ctx.params.postId!],
    );
    // A community-scoped link stops working the moment a post is unpublished.
    if (!row?.image_key || (payload.s !== 'staff' && row.status !== 'published')) throw notFound();
    const stored = await readObject(ctx.env.DOCS, row.image_key, ctx.config.encryptionKey);
    return fileResponse(stored.body, stored.contentType ?? row.image_type ?? 'image/jpeg', 'inline');
  });

  /** Resume links are only ever issued to the owner or to staff (see communityAccount / adminCommunity). */
  router.get('/api/community/files/resume/:userId', async (ctx: Ctx) => {
    const payload = await verifyValue(ctx.query.get('token') ?? '', ctx.config.tokenSecret);
    if (!payload || payload.k !== 'resume' || payload.u !== ctx.params.userId) throw unauthorized('That link has expired.');
    const row = await ctx.db.get<{ resume_key: string | null; resume_name: string | null; resume_type: string | null; customer_id: string }>(
      `SELECT resume_key, resume_name, resume_type, customer_id FROM community_accounts WHERE user_id = ?`,
      [ctx.params.userId!],
    );
    if (!row?.resume_key) throw notFound();
    if (payload.by) {
      await audit(ctx.db, {
        customerId: row.customer_id,
        userId: payload.by,
        action: 'community.resume_download',
        entityType: 'user',
        entityId: ctx.params.userId!,
        req: ctx.req,
      });
    }
    const stored = await readObject(ctx.env.DOCS, row.resume_key, ctx.config.encryptionKey);
    return fileResponse(
      stored.body,
      stored.contentType ?? row.resume_type ?? 'application/octet-stream',
      `attachment; filename="${(row.resume_name ?? 'resume').replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    );
  });
}
