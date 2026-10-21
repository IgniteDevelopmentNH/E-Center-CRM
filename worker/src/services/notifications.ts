import type { Db } from '../db/driver.ts';
import { createD1Db } from '../db/d1.ts';
import type { Config, Env } from '../env.ts';
import { loadConfig } from '../env.ts';
import { newId } from '../lib/ids.ts';
import type { MailMessage } from '../lib/mailer.ts';
import { actionEmail, deliverMail } from '../lib/mailer.ts';
import { mentionsToPlain } from '../lib/mentions.ts';
import { signValue, verifyValue } from '../lib/signedToken.ts';
import { nowIso } from '../lib/time.ts';

/**
 * Community email notifications, delivered through an outbox.
 *
 * Request handlers only ENQUEUE (one cheap INSERT, or one INSERT ... SELECT
 * for an announcement to every opted-in member). The Worker's scheduled
 * handler (cron, every minute) claims a small batch, re-checks that each
 * email is still wanted -- the message is still unread, the post is still
 * published, the member is still active and opted in -- renders it, and
 * sends it. Every row has a unique dedupe key, so retries and double clicks
 * never send twice, and failures are retried with backoff.
 *
 * Kinds and the preference that controls them:
 *   message       -> notify_messages       (new direct message, unread for 2 min)
 *   mention       -> notify_mentions       (@mentioned in a post or comment)
 *   announcement  -> notify_announcements  (staff chose "Email members" on a post/event)
 */

export type NotificationKind = 'message' | 'mention' | 'announcement';
export type PreferenceKind = 'messages' | 'mentions' | 'announcements';

const PREF_COLUMN: Record<NotificationKind, string> = {
  message: 'notify_messages',
  mention: 'notify_mentions',
  announcement: 'notify_announcements',
};
const PREF_FOR_KIND: Record<NotificationKind, PreferenceKind> = {
  message: 'messages',
  mention: 'mentions',
  announcement: 'announcements',
};

const MESSAGE_DELAY_SECONDS = 120;
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function enqueue(
  db: Db,
  input: {
    customerId: string;
    kind: NotificationKind;
    toUserId: string;
    refType: 'conversation' | 'post' | 'comment' | 'event';
    refId: string;
    actorId: string | null;
    dedupeKey: string;
    delaySeconds?: number;
  },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO email_outbox
       (id, customer_id, kind, to_user_id, ref_type, ref_id, actor_id, dedupe_key, status, send_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    [
      newId(),
      input.customerId,
      input.kind,
      input.toUserId,
      input.refType,
      input.refId,
      input.actorId,
      input.dedupeKey,
      isoIn(input.delaySeconds ?? 0),
      nowIso(),
    ],
  );
}

/**
 * One email per "unread streak": the key includes the recipient's last read
 * time, so a burst of messages produces one email, and the next email can
 * only be queued after they have read the conversation.
 */
export async function enqueueMessageNotification(
  db: Db,
  input: { customerId: string; conversationId: string; senderId: string; recipientId: string },
): Promise<void> {
  const member = await db.get<{ last_read_at: string | null }>(
    `SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?`,
    [input.conversationId, input.recipientId],
  );
  await enqueue(db, {
    customerId: input.customerId,
    kind: 'message',
    toUserId: input.recipientId,
    refType: 'conversation',
    refId: input.conversationId,
    actorId: input.senderId,
    dedupeKey: `message:${input.conversationId}:${input.recipientId}:${member?.last_read_at ?? 'never'}`,
    delaySeconds: MESSAGE_DELAY_SECONDS,
  });
}

/** Queues a mention email for each mentioned person (never the author themself). */
export async function enqueueMentionNotifications(
  db: Db,
  input: { customerId: string; sourceType: 'post' | 'comment'; sourceId: string; actorId: string; userIds: string[] },
): Promise<void> {
  for (const userId of input.userIds) {
    if (userId === input.actorId) continue;
    await enqueue(db, {
      customerId: input.customerId,
      kind: 'mention',
      toUserId: userId,
      refType: input.sourceType,
      refId: input.sourceId,
      actorId: input.actorId,
      dedupeKey: `mention:${input.sourceType}:${input.sourceId}:${userId}`,
    });
  }
}

/** Queues an announcement for every active, opted-in member. Returns how many were queued. */
export async function enqueueAnnouncement(
  db: Db,
  input: { customerId: string; refType: 'post' | 'event'; refId: string; actorId: string },
): Promise<number> {
  const timestamp = nowIso();
  await db.run(
    `INSERT OR IGNORE INTO email_outbox
       (id, customer_id, kind, to_user_id, ref_type, ref_id, actor_id, dedupe_key, status, send_after, created_at)
     SELECT lower(hex(randomblob(16))), ca.customer_id, 'announcement', ca.user_id, ?, ?, ?,
            'announcement:' || ? || ':' || ? || ':' || ca.user_id, 'queued', ?, ?
       FROM community_accounts ca JOIN users u ON u.id = ca.user_id
      WHERE ca.customer_id = ? AND ca.status = 'active' AND ca.notify_announcements = 1
        AND u.deleted_at IS NULL AND ca.user_id <> ?`,
    [input.refType, input.refId, input.actorId, input.refType, input.refId, timestamp, timestamp, input.customerId, input.actorId],
  );
  const row = await db.get<{ total: unknown }>(
    `SELECT COUNT(*) AS total FROM email_outbox WHERE kind = 'announcement' AND ref_type = ? AND ref_id = ?`,
    [input.refType, input.refId],
  );
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------ unsubscribe -- */

const UNSUBSCRIBE_TTL_SECONDS = 60 * 60 * 24 * 365;

export async function unsubscribeToken(config: Config, userId: string, pref: PreferenceKind): Promise<string> {
  return signValue({ k: 'unsub', u: userId, p: pref }, config.tokenSecret, UNSUBSCRIBE_TTL_SECONDS);
}

export async function readUnsubscribeToken(
  config: Config,
  token: string,
): Promise<{ userId: string; pref: PreferenceKind } | null> {
  const payload = await verifyValue(token, config.tokenSecret);
  if (!payload || payload.k !== 'unsub' || !payload.u) return null;
  if (!['messages', 'mentions', 'announcements'].includes(payload.p ?? '')) return null;
  return { userId: payload.u, pref: payload.p as PreferenceKind };
}

export const PREFERENCE_COLUMNS: Record<PreferenceKind, string> = {
  messages: 'notify_messages',
  mentions: 'notify_mentions',
  announcements: 'notify_announcements',
};

/* ----------------------------------------------------------- render -- */

const TIME_ZONE = 'America/New_York';

export function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function excerpt(text: string, max = 280): string {
  const clean = mentionsToPlain(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

interface OutboxRow {
  id: string;
  customer_id: string;
  kind: NotificationKind;
  to_user_id: string;
  ref_type: string;
  ref_id: string;
  actor_id: string | null;
  attempts: number;
}

type RenderResult = { send: MailMessage } | { skip: string };

async function displayName(db: Db, userId: string | null): Promise<string> {
  if (!userId) return 'Someone';
  const row = await db.get<{ first_name: string | null; last_name: string | null; name: string | null }>(
    `SELECT p.first_name, p.last_name, u.name FROM users u
       LEFT JOIN community_profiles p ON p.user_id = u.id WHERE u.id = ?`,
    [userId],
  );
  if (row?.first_name) return `${row.first_name} ${row.last_name ?? ''}`.trim();
  return row?.name ?? 'Someone';
}

async function render(db: Db, config: Config, base: string, row: OutboxRow): Promise<RenderResult> {
  const recipient = await db.get<{ email: string; first_name: string | null; status: string; pref: number }>(
    `SELECT u.email, p.first_name, ca.status, ca.${PREF_COLUMN[row.kind]} AS pref
       FROM users u
       JOIN community_accounts ca ON ca.user_id = u.id
       LEFT JOIN community_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.deleted_at IS NULL`,
    [row.to_user_id],
  );
  if (!recipient || recipient.status !== 'active') return { skip: 'recipient not active' };
  if (Number(recipient.pref) !== 1) return { skip: 'recipient opted out' };

  const pref = PREF_FOR_KIND[row.kind];
  const token = await unsubscribeToken(config, row.to_user_id, pref);
  const labels: Record<PreferenceKind, string> = {
    messages: 'Stop emails about new messages',
    mentions: 'Stop emails when someone mentions you',
    announcements: 'Stop emails about new posts and events',
  };
  const unsubscribe = {
    pageUrl: `${base}/unsubscribe?token=${encodeURIComponent(token)}`,
    oneClickUrl: `${base}/api/community/unsubscribe?token=${encodeURIComponent(token)}`,
    label: labels[pref],
  };
  const greeting = `Hi ${recipient.first_name ?? 'there'},`;
  const actor = await displayName(db, row.actor_id);

  if (row.kind === 'message') {
    const state = await db.get<{ last_read_at: string | null }>(
      `SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?`,
      [row.ref_id, row.to_user_id],
    );
    if (!state) return { skip: 'not a participant' };
    const latest = await db.get<{ body: string; created_at: string }>(
      `SELECT body, created_at FROM messages
        WHERE conversation_id = ? AND sender_id <> ? AND created_at > COALESCE(?, '')
        ORDER BY created_at DESC LIMIT 1`,
      [row.ref_id, row.to_user_id, state.last_read_at],
    );
    if (!latest) return { skip: 'already read' };
    return {
      send: actionEmail({
        to: recipient.email,
        subject: `${actor} sent you a message on ECenter Community`,
        greeting,
        intro: `${actor} sent you a message:`,
        excerpt: excerpt(latest.body, 200),
        actionLabel: 'Reply in ECenter Community',
        url: `${base}/messages?c=${encodeURIComponent(row.ref_id)}`,
        outro: 'You are getting this because you have message notifications on.',
        unsubscribe,
      }),
    };
  }

  if (row.kind === 'mention') {
    let postId = row.ref_id;
    let text: string;
    if (row.ref_type === 'comment') {
      const comment = await db.get<{ post_id: string; body: string; deleted_at: string | null }>(
        `SELECT post_id, body, deleted_at FROM post_comments WHERE id = ?`,
        [row.ref_id],
      );
      if (!comment || comment.deleted_at) return { skip: 'comment removed' };
      postId = comment.post_id;
      text = comment.body;
    } else {
      const post = await db.get<{ body: string }>(`SELECT body FROM posts WHERE id = ?`, [row.ref_id]);
      text = post?.body ?? '';
    }
    const post = await db.get<{ title: string; status: string; deleted_at: string | null }>(
      `SELECT title, status, deleted_at FROM posts WHERE id = ?`,
      [postId],
    );
    if (!post || post.deleted_at || post.status !== 'published') return { skip: 'post not published' };
    return {
      send: actionEmail({
        to: recipient.email,
        subject: `${actor} mentioned you on ECenter Community`,
        greeting,
        intro: `${actor} mentioned you ${row.ref_type === 'comment' ? 'in a comment on' : 'in'} "${post.title}":`,
        excerpt: excerpt(text, 240),
        actionLabel: 'View the post',
        url: `${base}/posts/${encodeURIComponent(postId)}`,
        outro: 'You are getting this because you have mention notifications on.',
        unsubscribe,
      }),
    };
  }

  // Announcements.
  if (row.ref_type === 'post') {
    const post = await db.get<{
      title: string;
      body: string;
      status: string;
      deleted_at: string | null;
      event_starts_at: string | null;
      event_location: string | null;
    }>(`SELECT title, body, status, deleted_at, event_starts_at, event_location FROM posts WHERE id = ?`, [row.ref_id]);
    if (!post || post.deleted_at || post.status !== 'published') return { skip: 'post not published' };
    const when = post.event_starts_at
      ? ` (${formatEventTime(post.event_starts_at)}${post.event_location ? `, ${post.event_location}` : ''})`
      : '';
    return {
      send: actionEmail({
        to: recipient.email,
        subject: post.event_starts_at ? `Upcoming event: ${post.title}` : `New on ECenter Community: ${post.title}`,
        greeting,
        intro: `${post.event_starts_at ? 'A new event was posted' : 'There is a new post'} on ECenter Community: "${post.title}"${when}.`,
        excerpt: excerpt(post.body),
        actionLabel: post.event_starts_at ? 'See the event' : 'Read the post',
        url: `${base}/posts/${encodeURIComponent(row.ref_id)}`,
        outro: 'You are getting this because you have announcement emails on.',
        unsubscribe,
      }),
    };
  }

  const event = await db.get<{
    name: string;
    starts_at: string;
    location: string | null;
    community_details: string | null;
    community_visible: number;
    deleted_at: string | null;
  }>(
    `SELECT name, starts_at, location, community_details, community_visible, deleted_at FROM events WHERE id = ?`,
    [row.ref_id],
  );
  if (!event || event.deleted_at || Number(event.community_visible) !== 1) return { skip: 'event not visible' };
  return {
    send: actionEmail({
      to: recipient.email,
      subject: `Upcoming event: ${event.name}`,
      greeting,
      intro: `${event.name} is coming up on ${formatEventTime(event.starts_at)}${event.location ? ` at ${event.location}` : ''}.`,
      excerpt: event.community_details ? excerpt(event.community_details) : undefined,
      actionLabel: 'See the event',
      url: `${base}/events/${encodeURIComponent(row.ref_id)}`,
      outro: 'You are getting this because you have announcement emails on.',
      unsubscribe,
    }),
  };
}

/* ------------------------------------------------------------ worker -- */

export interface OutboxRunResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  retrying: number;
}

/** Sends due notifications. Called by the scheduled handler; safe to run concurrently. */
export async function processOutbox(db: Db, env: Env, config: Config, limit = BATCH_SIZE): Promise<OutboxRunResult> {
  const result: OutboxRunResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, retrying: 0 };
  const now = nowIso();

  // A run that died mid-send leaves rows "sending"; give them back after 10 minutes.
  await db.run(`UPDATE email_outbox SET status = 'queued' WHERE status = 'sending' AND claimed_at < ?`, [
    new Date(Date.now() - 10 * 60_000).toISOString(),
  ]);

  const base = config.appUrl.replace(/\/+$/, '');
  if (!base) {
    console.warn('[notifications] APP_URL is not set; emails need absolute links, so nothing was sent.');
    return result;
  }

  // Claiming with a conditional UPDATE means two overlapping runs never take the same row.
  const claimed = await db.all<OutboxRow>(
    `UPDATE email_outbox SET status = 'sending', claimed_at = ?, attempts = attempts + 1
      WHERE id IN (SELECT id FROM email_outbox WHERE status = 'queued' AND send_after <= ?
                    ORDER BY send_after ASC LIMIT ?)
        AND status = 'queued'
      RETURNING id, customer_id, kind, to_user_id, ref_type, ref_id, actor_id, attempts`,
    [now, now, limit],
  );
  result.claimed = claimed.length;

  for (const row of claimed) {
    try {
      const rendered = await render(db, config, base, row);
      if ('skip' in rendered) {
        await db.run(`UPDATE email_outbox SET status = 'skipped', last_error = ? WHERE id = ?`, [rendered.skip, row.id]);
        result.skipped += 1;
        continue;
      }
      if (await deliverMail(env, config, rendered.send)) {
        await db.run(`UPDATE email_outbox SET status = 'sent', sent_at = ? WHERE id = ?`, [nowIso(), row.id]);
        result.sent += 1;
      } else {
        throw new Error('delivery failed');
      }
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 300);
      if (row.attempts >= MAX_ATTEMPTS) {
        await db.run(`UPDATE email_outbox SET status = 'failed', last_error = ? WHERE id = ?`, [message, row.id]);
        result.failed += 1;
      } else {
        await db.run(`UPDATE email_outbox SET status = 'queued', last_error = ?, send_after = ? WHERE id = ?`, [
          message,
          isoIn(300 * row.attempts),
          row.id,
        ]);
        result.retrying += 1;
      }
    }
  }
  return result;
}

/** Entry point for the Worker's `scheduled` handler. */
export async function runScheduledNotifications(env: Env): Promise<OutboxRunResult> {
  return processOutbox(createD1Db(env.DB), env, loadConfig(env));
}
