import type { SqlParam } from '../db/driver.ts';
import { badRequest, jsonResponse, notFound } from '../lib/http.ts';
import { positiveInt } from '../lib/validate.ts';
import type { Ctx, Router } from '../router.ts';
import { POST_SELECT, communityPostOut, viewerParams } from '../services/posts.ts';
import { defaultCustomerId } from './communityAccount.ts';
import { publicEvent, upcomingEvents } from './communityPosts.ts';
import { listPublishedCompetitions, loadPublishedCompetition } from './competitions.ts';

/**
 * Guest access: anyone, without an account, can read the main feed, upcoming
 * events and competitions. Only posts that are for everyone (not group-only)
 * and that their author has not hidden from guests are shown, and only CRM
 * events marked visible to guests. Guests never see comments, attendee lists,
 * member profile links or photos; member authors are shown as first name and
 * last initial. Liking, commenting and RSVPing need an account.
 */

const GUEST_POST_WHERE = [
  'p.customer_id = ?',
  `p.status = 'published'`,
  'p.deleted_at IS NULL',
  'p.published_at IS NOT NULL',
  `p.audience = 'everyone'`,
  'p.guest_visible = 1',
];

/** Read-only and unauthenticated, so it never writes (no per-request rate-limit rows). */
async function guestCustomer(ctx: Ctx): Promise<string> {
  return defaultCustomerId(ctx);
}

async function guestPostOut(ctx: Ctx, row: Record<string, unknown>) {
  const post = await communityPostOut(ctx, row, null);
  const { author } = post;
  const [first, ...rest] = author.name.split(/\s+/);
  const lastInitial = rest.length ? ` ${rest[rest.length - 1]!.charAt(0)}.` : '';
  return {
    ...post,
    author: {
      ...author,
      id: null,
      photoUrl: null,
      name: author.kind === 'member' ? `${first ?? ''}${lastInitial}`.trim() : author.name,
    },
    event: post.event ? { ...post.event, going: false } : null,
    likedByMe: false,
    canEdit: false,
    canDelete: false,
    groups: [],
  };
}

export function register(router: Router): void {
  router.get('/api/public/feed', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    const limit = positiveInt(ctx.query.get('limit'), 10, 30);
    const where = [...GUEST_POST_WHERE];
    const params: SqlParam[] = [customerId];
    const cursor = ctx.query.get('cursor');
    if (cursor) {
      const [publishedAt, id] = cursor.split('|');
      if (!publishedAt || !id) throw badRequest('Invalid cursor.');
      where.push('(p.published_at < ? OR (p.published_at = ? AND p.id < ?))');
      params.push(publishedAt, publishedAt, id);
    }
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${POST_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.published_at DESC, p.id DESC LIMIT ?`,
      [...viewerParams(null), ...params, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return jsonResponse({
      posts: await Promise.all(page.map((row) => guestPostOut(ctx, row))),
      nextCursor: rows.length > limit && last ? `${String(last.published_at)}|${String(last.id)}` : null,
    });
  });

  router.get('/api/public/posts/:id', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    const row = await ctx.db.get<Record<string, unknown>>(
      `${POST_SELECT} WHERE p.id = ? AND ${GUEST_POST_WHERE.join(' AND ')}`,
      [...viewerParams(null), ctx.params.id!, customerId],
    );
    if (!row) throw notFound('That post is not available. Sign in to see more.');
    return jsonResponse({ post: await guestPostOut(ctx, row), comments: [] });
  });

  router.get('/api/public/events', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    const limit = positiveInt(ctx.query.get('limit'), 5, 30);
    const rows = await upcomingEvents(ctx, customerId, null, limit);
    return jsonResponse({ events: rows.map(publicEvent) });
  });

  router.get('/api/public/events/:id', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    const row = await ctx.db.get<Record<string, unknown>>(
      `SELECT e.id, e.name, e.starts_at, e.ends_at, e.location, e.community_details, e.community_rsvp,
              e.community_age21, e.community_rsvp_public,
              (SELECT COUNT(*) FROM event_rsvps r WHERE r.target_type = 'event' AND r.target_id = e.id) AS rsvp_count
         FROM events e
        WHERE e.id = ? AND e.customer_id = ? AND e.deleted_at IS NULL AND e.community_visible = 1
          AND e.community_guest_visible = 1`,
      [ctx.params.id!, customerId],
    );
    if (!row) throw notFound('That event is not available. Sign in to see more.');
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
        going: false,
        age21: Number(row.community_age21) === 1,
        attendeesPublic: false,
        guestVisible: true,
      },
    });
  });

  router.get('/api/public/competitions', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    return jsonResponse({ competitions: await listPublishedCompetitions(ctx, customerId) });
  });

  router.get('/api/public/competitions/:id', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    return jsonResponse({ competition: await loadPublishedCompetition(ctx, customerId, ctx.params.id!) });
  });
}
