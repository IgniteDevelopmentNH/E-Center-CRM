import type { SqlParam } from '../db/driver.ts';
import { badRequest } from '../lib/http.ts';
import { nowIso } from '../lib/time.ts';
import type { Ctx } from '../router.ts';
import { readIcons, readQuestions, rsvpCountSql } from './eventOptions.ts';
import { POST_SELECT, viewerParams } from './posts.ts';

/**
 * The community feed is events: event posts, CRM events shown to the
 * community, and competition deadlines, merged in date order. One query picks
 * the page; the details are then fetched in bulk, so a page costs the same
 * few queries however long it is.
 */

/** Columns for a CRM event as the community sees it. One `?`: the viewer's user id. */
export const COMMUNITY_EVENT_COLUMNS = `
  e.id, e.name, e.starts_at, e.ends_at, e.location, e.community_details, e.community_rsvp,
  e.community_age21, e.community_rsvp_public, e.community_guest_visible, e.community_rsvp_guests,
  e.community_icons, e.community_questions,
  ${rsvpCountSql('event', 'e.id')} AS rsvp_count,
  EXISTS (SELECT 1 FROM event_rsvps r WHERE r.target_type = 'event' AND r.target_id = e.id AND r.user_id = ?) AS going`;

export function communityEventOut(row: Record<string, unknown>) {
  return {
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
    guestRsvp: Number(row.community_rsvp_guests) === 1,
    icons: readIcons(row.community_icons),
    questions: readQuestions(row.community_questions),
  };
}

const placeholders = (values: unknown[]) => values.map(() => '?').join(', ');

/** Events stay under "Upcoming" for a few hours after they start. */
const STILL_UPCOMING_MS = 6 * 60 * 60 * 1000;

export async function loadEventFeed<P>(
  ctx: Ctx,
  options: {
    customerId: string;
    /** null = a guest: only what has been left visible to guests. */
    viewerId: string | null;
    postOut: (row: Record<string, unknown>) => Promise<P>;
  },
) {
  const { customerId, viewerId, postOut } = options;
  const guest = viewerId === null;
  const past = ctx.query.get('when') === 'past';
  const limit = Math.min(Math.max(Number.parseInt(ctx.query.get('limit') ?? '', 10) || 10, 1), 30);
  const cutoff = new Date(Date.now() - STILL_UPCOMING_MS).toISOString();

  const outer: string[] = [past ? 'starts_at < ?' : 'starts_at >= ?'];
  const outerParams: SqlParam[] = [cutoff];
  const cursor = ctx.query.get('cursor');
  if (cursor) {
    const [startsAt, id] = cursor.split('|');
    if (!startsAt || !id) throw badRequest('Invalid cursor.');
    const direction = past ? '<' : '>';
    outer.push(`(starts_at ${direction} ? OR (starts_at = ? AND id ${direction} ?))`);
    outerParams.push(startsAt, startsAt, id);
  }

  // Group-only events stay in their groups' feeds.
  const pageRows = await ctx.db.all<{ source: string; id: string; starts_at: string }>(
    `SELECT * FROM (
       SELECT 'post' AS source, p.id, p.event_starts_at AS starts_at FROM posts p
        WHERE p.customer_id = ? AND p.status = 'published' AND p.event_starts_at IS NOT NULL
          AND p.deleted_at IS NULL AND p.audience = 'everyone' ${guest ? 'AND p.guest_visible = 1' : ''}
       UNION ALL
       SELECT 'event' AS source, e.id, e.starts_at FROM events e
        WHERE e.customer_id = ? AND e.community_visible = 1 AND e.deleted_at IS NULL
          ${guest ? 'AND e.community_guest_visible = 1' : ''}
       UNION ALL
       SELECT 'deadline' AS source, d.id, d.due_at AS starts_at
         FROM competition_deadlines d JOIN competitions c ON c.id = d.competition_id
        WHERE d.customer_id = ? AND c.status = 'published' AND c.deleted_at IS NULL
     )
     WHERE ${outer.join(' AND ')}
     ORDER BY starts_at ${past ? 'DESC' : 'ASC'}, id ${past ? 'DESC' : 'ASC'}
     LIMIT ?`,
    [customerId, customerId, customerId, ...outerParams, limit + 1],
  );
  const page = pageRows.slice(0, limit);
  const idsOf = (source: string) => page.filter((row) => row.source === source).map((row) => row.id);
  const postIds = idsOf('post');
  const eventIds = idsOf('event');
  const deadlineIds = idsOf('deadline');

  const [postRows, eventRows, deadlineRows] = await Promise.all([
    postIds.length
      ? ctx.db.all<Record<string, unknown>>(`${POST_SELECT} WHERE p.id IN (${placeholders(postIds)})`, [
          ...viewerParams(viewerId === null ? null : { userId: viewerId }),
          ...postIds,
        ])
      : [],
    eventIds.length
      ? ctx.db.all<Record<string, unknown>>(
          `SELECT ${COMMUNITY_EVENT_COLUMNS} FROM events e WHERE e.id IN (${placeholders(eventIds)})`,
          [viewerId ?? '', ...eventIds],
        )
      : [],
    deadlineIds.length
      ? ctx.db.all<Record<string, unknown>>(
          `SELECT d.id, d.label, d.due_at, c.id AS competition_id, c.title, c.summary, c.prize
             FROM competition_deadlines d JOIN competitions c ON c.id = d.competition_id
            WHERE d.id IN (${placeholders(deadlineIds)})`,
          deadlineIds,
        )
      : [],
  ]);

  const posts = new Map(await Promise.all(postRows.map(async (row) => [String(row.id), await postOut(row)] as const)));
  const events = new Map(eventRows.map((row) => [String(row.id), communityEventOut(row)]));
  const deadlines = new Map(deadlineRows.map((row) => [String(row.id), row]));
  const now = nowIso();

  const items = page.flatMap((row): unknown[] => {
    if (row.source === 'post') {
      const post = posts.get(row.id);
      return post ? [{ kind: 'post' as const, startsAt: row.starts_at, post }] : [];
    }
    if (row.source === 'event') {
      const event = events.get(row.id);
      return event ? [{ kind: 'event' as const, startsAt: row.starts_at, event }] : [];
    }
    const deadline = deadlines.get(row.id);
    if (!deadline) return [];
    return [
      {
        kind: 'deadline' as const,
        startsAt: row.starts_at,
        deadline: {
          id: row.id,
          label: String(deadline.label),
          dueAt: String(deadline.due_at),
          passed: String(deadline.due_at) < now,
          competitionId: String(deadline.competition_id),
          title: String(deadline.title),
          summary: deadline.summary ? String(deadline.summary) : null,
          prize: deadline.prize ? String(deadline.prize) : null,
        },
      },
    ];
  });
  const last = page[page.length - 1];
  return { items, nextCursor: pageRows.length > limit && last ? `${last.starts_at}|${last.id}` : null };
}
