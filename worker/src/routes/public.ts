import { normaliseEmail } from '../lib/communityValidate.ts';
import { badRequest, clientIp, jsonResponse, notFound, readJson, unauthorized } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { enforceRateLimit } from '../lib/rateLimit.ts';
import { signValue, verifyValue } from '../lib/signedToken.ts';
import { nowIso } from '../lib/time.ts';
import { positiveInt, requiredEmail, requiredString } from '../lib/validate.ts';
import type { Ctx, Router } from '../router.ts';
import { assertEmailNotBlocked } from '../services/blockedEmails.ts';
import { parseAnswers, readQuestions } from '../services/eventOptions.ts';
import type { RegistrationQuestion } from '../services/eventOptions.ts';
import { COMMUNITY_EVENT_COLUMNS, communityEventOut, loadEventFeed } from '../services/feed.ts';
import { POST_SELECT, communityPostOut, viewerParams } from '../services/posts.ts';
import { defaultCustomerId } from './communityAccount.ts';
import { publicEvent, rsvpTotal, upcomingEvents } from './communityPosts.ts';
import { listPublishedCompetitions, loadPublishedCompetition } from './competitions.ts';

/**
 * Guest access: anyone, without an account, can read the main feed, upcoming
 * events and competitions. Only posts that are for everyone (not group-only)
 * and that their author has not hidden from guests are shown, and only CRM
 * events marked visible to guests. Guests never see comments, attendee lists,
 * member profile links or photos; member authors are shown as first name and
 * last initial. Liking and commenting need an account. RSVPing needs one too,
 * unless the organiser opened that event's RSVPs to guests.
 */

const GUEST_POST_WHERE = [
  'p.customer_id = ?',
  `p.status = 'published'`,
  'p.deleted_at IS NULL',
  'p.published_at IS NOT NULL',
  `p.audience = 'everyone'`,
  'p.guest_visible = 1',
];

/** Reads never write (no per-request rate-limit rows); only guest RSVPs do. */
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

const CANCEL_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

interface GuestRsvpRules {
  targetType: 'post' | 'event';
  targetId: string;
  customerId: string;
  age21: boolean;
  questions: RegistrationQuestion[];
}

/** One RSVP per email per event: sending the form again updates it. */
async function saveGuestRsvp(ctx: Ctx, rules: GuestRsvpRules) {
  const body = await readJson(ctx.req);
  await enforceRateLimit(ctx.db, `guest-rsvp:${clientIp(ctx.req) || 'unknown'}`, {
    limit: 20,
    windowSeconds: 3600,
    message: 'Too many RSVPs from this connection. Please try again later.',
  });
  // Hidden from people; automated form fillers complete it. Looks like success to them, stores nothing.
  if (typeof body.website === 'string' && body.website.trim()) {
    return { going: true, rsvpCount: await rsvpTotal(ctx, rules.targetType, rules.targetId), cancelToken: null };
  }
  const name = requiredString(body.name, 'Name', { max: 120 });
  const email = normaliseEmail(requiredEmail(body.email));
  await assertEmailNotBlocked(ctx.db, rules.customerId, email);
  if (rules.age21 && body.over21 !== true) {
    throw badRequest('This is a 21+ event. Confirm you are 21 or older to RSVP.', 'Over 21');
  }
  const answers = parseAnswers(rules.questions, body.answers);
  const timestamp = nowIso();
  await ctx.db.run(
    `INSERT INTO event_guest_rsvps
       (id, customer_id, target_type, target_id, name, email, over21_confirmed, answers_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (target_type, target_id, email)
     DO UPDATE SET name = excluded.name, over21_confirmed = excluded.over21_confirmed,
                   answers_json = excluded.answers_json, updated_at = excluded.updated_at`,
    [newId(), rules.customerId, rules.targetType, rules.targetId, name, email, rules.age21 ? 1 : 0, answers, timestamp, timestamp],
  );
  const cancelToken = await signValue(
    { k: 'guest-rsvp', t: rules.targetType, i: rules.targetId, e: email },
    ctx.config.tokenSecret,
    CANCEL_TOKEN_TTL_SECONDS,
  );
  return { going: true, rsvpCount: await rsvpTotal(ctx, rules.targetType, rules.targetId), cancelToken };
}

export function register(router: Router): void {
  router.get('/api/public/feed', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    return jsonResponse(await loadEventFeed(ctx, { customerId, viewerId: null, postOut: (row) => guestPostOut(ctx, row) }));
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
      `SELECT ${COMMUNITY_EVENT_COLUMNS}
         FROM events e
        WHERE e.id = ? AND e.customer_id = ? AND e.deleted_at IS NULL AND e.community_visible = 1
          AND e.community_guest_visible = 1`,
      ['', ctx.params.id!, customerId],
    );
    if (!row) throw notFound('That event is not available. Sign in to see more.');
    return jsonResponse({ event: { ...communityEventOut(row), going: false, attendeesPublic: false } });
  });

  /* ------------------------------------------------- guest RSVPs -- */

  router.post('/api/public/posts/:id/rsvp', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    const post = await ctx.db.get<Record<string, unknown>>(
      `SELECT p.id, p.event_age21, p.rsvp_questions FROM posts p
        WHERE p.id = ? AND ${GUEST_POST_WHERE.join(' AND ')} AND p.event_starts_at IS NOT NULL AND p.rsvp_enabled = 1 AND p.rsvp_guests = 1`,
      [ctx.params.id!, customerId],
    );
    if (!post) throw notFound('This event is not taking RSVPs from guests. Sign in to RSVP.');
    return jsonResponse(
      await saveGuestRsvp(ctx, {
        targetType: 'post',
        targetId: String(post.id),
        customerId,
        age21: Number(post.event_age21) === 1,
        questions: readQuestions(post.rsvp_questions),
      }),
    );
  });

  router.post('/api/public/events/:id/rsvp', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    const event = await ctx.db.get<Record<string, unknown>>(
      `SELECT id, community_age21, community_questions FROM events
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL AND community_visible = 1
          AND community_guest_visible = 1 AND community_rsvp = 1 AND community_rsvp_guests = 1`,
      [ctx.params.id!, customerId],
    );
    if (!event) throw notFound('This event is not taking RSVPs from guests. Sign in to RSVP.');
    return jsonResponse(
      await saveGuestRsvp(ctx, {
        targetType: 'event',
        targetId: String(event.id),
        customerId,
        age21: Number(event.community_age21) === 1,
        questions: readQuestions(event.community_questions),
      }),
    );
  });

  /** A guest removes their own RSVP with the token they were given when they made it. */
  router.post('/api/public/rsvp/cancel', async (ctx: Ctx) => {
    const body = await readJson(ctx.req);
    const payload = await verifyValue(typeof body.token === 'string' ? body.token : '', ctx.config.tokenSecret);
    if (!payload || payload.k !== 'guest-rsvp' || !payload.i || !payload.e || (payload.t !== 'post' && payload.t !== 'event')) {
      throw unauthorized('That RSVP could not be found.');
    }
    await ctx.db.run(`DELETE FROM event_guest_rsvps WHERE target_type = ? AND target_id = ? AND email = ?`, [
      payload.t,
      payload.i,
      payload.e,
    ]);
    return jsonResponse({ going: false, rsvpCount: await rsvpTotal(ctx, payload.t, payload.i) });
  });

  router.get('/api/public/competitions', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    return jsonResponse({ competitions: await listPublishedCompetitions(ctx, customerId, positiveInt(ctx.query.get('limit'), 100, 100)) });
  });

  router.get('/api/public/competitions/:id', async (ctx: Ctx) => {
    const customerId = await guestCustomer(ctx);
    return jsonResponse({ competition: await loadPublishedCompetition(ctx, customerId, ctx.params.id!) });
  });
}
