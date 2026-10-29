import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { optionalWebLink } from '../lib/communityValidate.ts';
import { badRequest, forbidden, jsonResponse, notFound, readJson, unauthorized } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { signValue, verifyValue } from '../lib/signedToken.ts';
import { nowIso } from '../lib/time.ts';
import { flag, optionalString, positiveInt, requiredString } from '../lib/validate.ts';
import { isStaffRole, requireActiveCommunityMember, requireCommunityViewer } from '../middleware/auth.ts';
import type { AuthContext, Ctx, Router } from '../router.ts';
import { photoUrl } from '../services/community.ts';
import { storeCommunityUpload } from '../services/communityFiles.ts';
import { isModerator } from '../services/posts.ts';
import { deleteObject, readObject } from '../services/storage.ts';
import { fileResponse } from './communityContent.ts';

/**
 * Member businesses. Students and mentors (active community members) create
 * business profiles: logo, tagline, about, industry, website, location,
 * whether they are hiring or looking to network, and a small photo gallery.
 * Owners edit their own; staff owners/editors can edit or remove any. A
 * business disappears from the directory while its owner's account is not
 * active. Images live in the private bucket behind short-lived signed links.
 */

const MAX_BUSINESSES_PER_OWNER = 5;
const MAX_PHOTOS = 12;
const IMAGE_TTL_SECONDS = 60 * 60 * 6;

const BUSINESS_SELECT = `
  SELECT b.*, p.first_name AS owner_first_name, p.last_name AS owner_last_name, p.photo_key AS owner_photo_key,
         ca.account_type AS owner_account_type,
         (SELECT COUNT(*) FROM business_photos bp WHERE bp.business_id = b.id) AS photo_count
    FROM businesses b
    JOIN community_accounts ca ON ca.user_id = b.owner_id
    JOIN community_profiles p ON p.user_id = b.owner_id`;

function staffModerator(auth: AuthContext): boolean {
  return isStaffRole(auth.role) && isModerator(auth);
}

async function imageUrl(ctx: Ctx, kind: 'logo' | 'photo', id: string, key: unknown): Promise<string | null> {
  if (!key) return null;
  const token = await signValue({ k: `business-${kind}`, i: id }, ctx.config.tokenSecret, IMAGE_TTL_SECONDS);
  return `/api/community/files/business/${kind}/${id}?token=${encodeURIComponent(token)}`;
}

async function businessOut(ctx: Ctx, row: Record<string, unknown>, auth: AuthContext, withPhotos = false) {
  const id = String(row.id);
  const ownerId = String(row.owner_id);
  const photos = withPhotos
    ? await ctx.db.all<Record<string, unknown>>(
        `SELECT id, image_key, caption, created_at FROM business_photos WHERE business_id = ? ORDER BY created_at ASC, id ASC`,
        [id],
      )
    : [];
  return {
    id,
    name: String(row.name),
    tagline: row.tagline ? String(row.tagline) : null,
    description: row.description ? String(row.description) : null,
    industry: row.industry ? String(row.industry) : null,
    website: row.website ? String(row.website) : null,
    location: row.location ? String(row.location) : null,
    hiring: Number(row.hiring) === 1,
    hiringDetails: row.hiring_details ? String(row.hiring_details) : null,
    networking: Number(row.networking) === 1,
    lookingFor: row.looking_for ? String(row.looking_for) : null,
    logoUrl: await imageUrl(ctx, 'logo', id, row.logo_key),
    photoCount: Number(row.photo_count ?? 0),
    photos: await Promise.all(
      photos.map(async (photo) => ({
        id: String(photo.id),
        url: (await imageUrl(ctx, 'photo', String(photo.id), photo.image_key))!,
        caption: photo.caption ? String(photo.caption) : null,
      })),
    ),
    owner: {
      id: ownerId,
      name: `${String(row.owner_first_name)} ${String(row.owner_last_name ?? '')}`.trim(),
      accountType: String(row.owner_account_type),
      photoUrl: await photoUrl(ctx, ownerId, row.owner_photo_key),
    },
    canEdit: ownerId === auth.userId || staffModerator(auth),
    updatedAt: String(row.updated_at),
  };
}

function parseBusiness(body: Record<string, unknown>) {
  const hiring = flag(body.hiring);
  const networking = flag(body.networking);
  return {
    name: requiredString(body.name, 'Business name', { max: 120 }),
    tagline: optionalString(body.tagline, 'Tagline', { max: 160 }),
    description: optionalString(body.description, 'About', { max: 5000 }),
    industry: optionalString(body.industry, 'Industry', { max: 80 }),
    website: optionalWebLink(body.website, 'Website'),
    location: optionalString(body.location, 'Location', { max: 120 }),
    hiring,
    hiringDetails: hiring ? optionalString(body.hiringDetails, 'Hiring details', { max: 1000 }) : null,
    networking,
    lookingFor: networking ? optionalString(body.lookingFor, 'Looking for', { max: 1000 }) : null,
  };
}

async function loadBusiness(ctx: Ctx, id: string, customerId: string) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `${BUSINESS_SELECT} WHERE b.id = ? AND b.customer_id = ? AND b.deleted_at IS NULL AND ca.status = 'active'`,
    [id, customerId],
  );
  if (!row) throw notFound('That business is not available.');
  return row;
}

async function loadEditable(ctx: Ctx, auth: AuthContext, id: string) {
  const row = await loadBusiness(ctx, id, auth.customerId);
  if (String(row.owner_id) !== auth.userId && !staffModerator(auth)) throw forbidden('You can only edit your own business.');
  return row;
}

export function register(router: Router): void {
  router.get('/api/community/businesses', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const where = ['b.customer_id = ?', 'b.deleted_at IS NULL', `ca.status = 'active'`];
    const params: SqlParam[] = [auth.customerId];
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    if (q) {
      const like = `%${q}%`;
      where.push(`(LOWER(b.name) LIKE ? OR LOWER(COALESCE(b.tagline, '')) LIKE ? OR LOWER(COALESCE(b.description, '')) LIKE ?
                   OR LOWER(COALESCE(b.industry, '')) LIKE ? OR LOWER(p.first_name || ' ' || p.last_name) LIKE ?)`);
      params.push(like, like, like, like, like);
    }
    if (ctx.query.get('hiring') === '1') where.push('b.hiring = 1');
    if (ctx.query.get('networking') === '1') where.push('b.networking = 1');
    const industry = (ctx.query.get('industry') ?? '').trim();
    if (industry) {
      where.push('LOWER(b.industry) = LOWER(?)');
      params.push(industry);
    }
    const owner = ctx.query.get('owner');
    if (owner) {
      where.push('b.owner_id = ?');
      params.push(owner === 'me' ? auth.userId : owner);
    }
    const limit = positiveInt(ctx.query.get('limit'), 24, 100);
    const page = positiveInt(ctx.query.get('page'), 1, 1000);
    const total = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM businesses b
         JOIN community_accounts ca ON ca.user_id = b.owner_id
         JOIN community_profiles p ON p.user_id = b.owner_id
        WHERE ${where.join(' AND ')}`,
      params,
    );
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${BUSINESS_SELECT} WHERE ${where.join(' AND ')} ORDER BY b.updated_at DESC, b.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const industries = await ctx.db.all<{ industry: string }>(
      `SELECT DISTINCT b.industry FROM businesses b JOIN community_accounts ca ON ca.user_id = b.owner_id
        WHERE b.customer_id = ? AND b.deleted_at IS NULL AND ca.status = 'active' AND b.industry IS NOT NULL
        ORDER BY b.industry ASC`,
      [auth.customerId],
    );
    const count = Number(total?.total ?? 0);
    return jsonResponse({
      businesses: await Promise.all(rows.map((row) => businessOut(ctx, row, auth))),
      industries: industries.map((r) => r.industry),
      page,
      limit,
      total: count,
      hasMore: page * limit < count,
    });
  });

  router.get('/api/community/businesses/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    return jsonResponse({ business: await businessOut(ctx, await loadBusiness(ctx, ctx.params.id!, auth.customerId), auth, true) });
  });

  router.post('/api/community/businesses', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const owned = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM businesses WHERE owner_id = ? AND deleted_at IS NULL`,
      [auth.userId],
    );
    if (Number(owned?.total ?? 0) >= MAX_BUSINESSES_PER_OWNER) {
      throw badRequest(`You can list up to ${MAX_BUSINESSES_PER_OWNER} businesses.`);
    }
    const fields = parseBusiness(await readJson(ctx.req));
    const id = newId();
    const timestamp = nowIso();
    await ctx.db.run(
      `INSERT INTO businesses (id, customer_id, owner_id, name, tagline, description, industry, website, location,
                               hiring, hiring_details, networking, looking_for, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.customerId, auth.userId, fields.name, fields.tagline, fields.description, fields.industry,
        fields.website, fields.location, fields.hiring, fields.hiringDetails, fields.networking, fields.lookingFor,
        timestamp, timestamp,
      ],
    );
    return jsonResponse({ business: await businessOut(ctx, await loadBusiness(ctx, id, auth.customerId), auth, true) }, { status: 201 });
  });

  router.put('/api/community/businesses/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await loadEditable(ctx, auth, ctx.params.id!);
    const fields = parseBusiness(await readJson(ctx.req));
    await ctx.db.run(
      `UPDATE businesses SET name = ?, tagline = ?, description = ?, industry = ?, website = ?, location = ?,
              hiring = ?, hiring_details = ?, networking = ?, looking_for = ?, updated_at = ?
        WHERE id = ?`,
      [
        fields.name, fields.tagline, fields.description, fields.industry, fields.website, fields.location,
        fields.hiring, fields.hiringDetails, fields.networking, fields.lookingFor, nowIso(), String(row.id),
      ],
    );
    return jsonResponse({ business: await businessOut(ctx, await loadBusiness(ctx, String(row.id), auth.customerId), auth, true) });
  });

  router.delete('/api/community/businesses/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await loadEditable(ctx, auth, ctx.params.id!);
    const timestamp = nowIso();
    await ctx.db.run(`UPDATE businesses SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?`, [
      timestamp, auth.userId, timestamp, String(row.id),
    ]);
    if (String(row.owner_id) !== auth.userId) {
      await audit(ctx.db, {
        customerId: auth.customerId,
        userId: auth.userId,
        action: 'business.delete',
        entityType: 'business',
        entityId: String(row.id),
        metadata: { name: String(row.name), ownerId: String(row.owner_id) },
        req: ctx.req,
      });
    }
    return jsonResponse({ ok: true });
  });

  /* ------------------------------------------------------ images -- */

  router.post('/api/community/businesses/:id/logo', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await loadEditable(ctx, auth, ctx.params.id!);
    const stored = await storeCommunityUpload(ctx, { purpose: 'business-image', customerId: auth.customerId, ownerId: String(row.id) });
    await ctx.db.run(`UPDATE businesses SET logo_key = ?, logo_type = ?, updated_at = ? WHERE id = ?`, [
      stored.key, stored.type, nowIso(), String(row.id),
    ]);
    if (row.logo_key) await deleteObject(ctx.env.DOCS, String(row.logo_key)).catch(() => undefined);
    return jsonResponse({ business: await businessOut(ctx, await loadBusiness(ctx, String(row.id), auth.customerId), auth, true) });
  });

  router.delete('/api/community/businesses/:id/logo', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await loadEditable(ctx, auth, ctx.params.id!);
    await ctx.db.run(`UPDATE businesses SET logo_key = NULL, logo_type = NULL, updated_at = ? WHERE id = ?`, [nowIso(), String(row.id)]);
    if (row.logo_key) await deleteObject(ctx.env.DOCS, String(row.logo_key)).catch(() => undefined);
    return jsonResponse({ business: await businessOut(ctx, await loadBusiness(ctx, String(row.id), auth.customerId), auth, true) });
  });

  /** Gallery photo upload: multipart `file`, optional `?caption=`. */
  router.post('/api/community/businesses/:id/photos', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await loadEditable(ctx, auth, ctx.params.id!);
    if (Number(row.photo_count ?? 0) >= MAX_PHOTOS) throw badRequest(`A business can have up to ${MAX_PHOTOS} photos.`, 'File');
    const caption = optionalString(ctx.query.get('caption') ?? undefined, 'Caption', { max: 200 });
    const stored = await storeCommunityUpload(ctx, { purpose: 'business-image', customerId: auth.customerId, ownerId: String(row.id) });
    const timestamp = nowIso();
    await ctx.db.batch([
      {
        sql: `INSERT INTO business_photos (id, business_id, customer_id, image_key, image_type, caption, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [newId(), String(row.id), auth.customerId, stored.key, stored.type, caption, timestamp],
      },
      { sql: `UPDATE businesses SET updated_at = ? WHERE id = ?`, params: [timestamp, String(row.id)] },
    ]);
    return jsonResponse({ business: await businessOut(ctx, await loadBusiness(ctx, String(row.id), auth.customerId), auth, true) }, { status: 201 });
  });

  router.delete('/api/community/businesses/:id/photos/:photoId', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await loadEditable(ctx, auth, ctx.params.id!);
    const photo = await ctx.db.get<{ id: string; image_key: string }>(
      `SELECT id, image_key FROM business_photos WHERE id = ? AND business_id = ?`,
      [ctx.params.photoId!, String(row.id)],
    );
    if (!photo) throw notFound('That photo was already removed.');
    await ctx.db.run(`DELETE FROM business_photos WHERE id = ?`, [photo.id]);
    await deleteObject(ctx.env.DOCS, photo.image_key).catch(() => undefined);
    return jsonResponse({ business: await businessOut(ctx, await loadBusiness(ctx, String(row.id), auth.customerId), auth, true) });
  });

  /** Signed links only: issued above to people who could see the business. */
  router.get('/api/community/files/business/:kind/:id', async (ctx: Ctx) => {
    const kind = ctx.params.kind;
    if (kind !== 'logo' && kind !== 'photo') throw notFound();
    const payload = await verifyValue(ctx.query.get('token') ?? '', ctx.config.tokenSecret);
    if (!payload || payload.k !== `business-${kind}` || payload.i !== ctx.params.id) throw unauthorized('That link has expired.');
    const row =
      kind === 'logo'
        ? await ctx.db.get<{ key: string | null; type: string | null }>(
            `SELECT logo_key AS key, logo_type AS type FROM businesses WHERE id = ? AND deleted_at IS NULL`,
            [ctx.params.id!],
          )
        : await ctx.db.get<{ key: string | null; type: string | null }>(
            `SELECT bp.image_key AS key, bp.image_type AS type FROM business_photos bp
               JOIN businesses b ON b.id = bp.business_id AND b.deleted_at IS NULL
              WHERE bp.id = ?`,
            [ctx.params.id!],
          );
    if (!row?.key) throw notFound();
    const stored = await readObject(ctx.env.DOCS, row.key, ctx.config.encryptionKey);
    return fileResponse(stored.body, stored.contentType ?? row.type ?? 'image/jpeg', 'inline');
  });
}
