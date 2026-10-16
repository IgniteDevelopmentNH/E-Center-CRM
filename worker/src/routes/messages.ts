import type { SqlParam } from '../db/driver.ts';
import { messageBody } from '../lib/communityValidate.ts';
import { badRequest, conflict, forbidden, jsonResponse, notFound, readJson, tooManyRequests } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { enforceRateLimit } from '../lib/rateLimit.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, positiveInt, requiredString } from '../lib/validate.ts';
import { requireActiveCommunityMember } from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';
import { PUBLIC_PROFILE_COLUMNS, loadTags, publicMemberOut } from '../services/community.ts';

/**
 * Persistent one-to-one messaging between community identities.
 *
 * Access is by PARTICIPATION ONLY: every read and write checks that the
 * caller is a member of the conversation. There is deliberately no staff
 * override -- administrative CRM access does not open anyone's private
 * messages. Staff take part only through their own community identity.
 *
 * Updates are delivered by light polling from the client (the Worker has no
 * realtime channel today); each poll goes through the same participant check.
 */

const MESSAGE_KINDS = ['text', 'meeting_request'] as const;
const SENDS_PER_MINUTE = 20;

async function requireParticipant(ctx: Ctx, conversationId: string, userId: string) {
  const row = await ctx.db.get<{ id: string; other_id: string; last_read_at: string | null }>(
    `SELECT c.id, other.user_id AS other_id, me.last_read_at
       FROM conversations c
       JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> ?
      WHERE c.id = ?`,
    [userId, userId, conversationId],
  );
  // 404 rather than 403, so a non-participant cannot even confirm the conversation exists.
  if (!row) throw notFound('That conversation was not found.');
  return row;
}

/** Public profiles for the other side of conversations; unavailable accounts are labelled, not hidden. */
async function participantsById(ctx: Ctx, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<string, Awaited<ReturnType<typeof publicMemberOut>>>();
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT ${PUBLIC_PROFILE_COLUMNS}
       FROM community_accounts ca
       JOIN community_profiles p ON p.user_id = ca.user_id
       JOIN users u ON u.id = ca.user_id
      WHERE ca.user_id IN (${unique.map(() => '?').join(', ')})`,
    unique,
  );
  const tags = await loadTags(ctx.db, unique);
  const map = new Map<string, Awaited<ReturnType<typeof publicMemberOut>>>();
  for (const row of rows) map.set(String(row.user_id), await publicMemberOut(ctx, row, tags.get(String(row.user_id))));
  return map;
}

function messageOut(row: Record<string, unknown>, viewerId: string) {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    senderId: String(row.sender_id),
    mine: String(row.sender_id) === viewerId,
    body: String(row.body),
    kind: String(row.kind),
    clientKey: String(row.client_key),
    createdAt: String(row.created_at),
  };
}

async function recipientIsAvailable(ctx: Ctx, userId: string, customerId: string): Promise<boolean> {
  const row = await ctx.db.get(
    `SELECT 1 AS ok FROM community_accounts ca JOIN users u ON u.id = ca.user_id
      WHERE ca.user_id = ? AND ca.customer_id = ? AND ca.status = 'active'
        AND ca.onboarding_completed_at IS NOT NULL AND u.deleted_at IS NULL`,
    [userId, customerId],
  );
  return !!row;
}

export function register(router: Router): void {
  router.get('/api/community/conversations', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const rows = await ctx.db.all<Record<string, unknown>>(
      `SELECT c.id, c.created_at, c.last_message_at, other.user_id AS other_id,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
              (SELECT m.sender_id FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> ?
                  AND m.created_at > COALESCE(me.last_read_at, '')) AS unread
         FROM conversation_members me
         JOIN conversations c ON c.id = me.conversation_id
         JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> me.user_id
        WHERE me.user_id = ?
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT 200`,
      [auth.userId, auth.userId],
    );
    const people = await participantsById(ctx, rows.map((r) => String(r.other_id)));
    return jsonResponse({
      conversations: rows.map((row) => ({
        id: String(row.id),
        other: people.get(String(row.other_id)) ?? null,
        lastMessage: row.last_body
          ? { body: String(row.last_body).slice(0, 140), mine: String(row.last_sender) === auth.userId }
          : null,
        lastMessageAt: row.last_message_at ? String(row.last_message_at) : null,
        unreadCount: Number(row.unread ?? 0),
      })),
    });
  });

  router.get('/api/community/messages/unread-count', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const row = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM conversation_members me
         JOIN messages m ON m.conversation_id = me.conversation_id
        WHERE me.user_id = ? AND m.sender_id <> ? AND m.created_at > COALESCE(me.last_read_at, '')`,
      [auth.userId, auth.userId],
    );
    return jsonResponse({ unread: Number(row?.total ?? 0) });
  });

  /** Find-or-create the single conversation between the caller and one other member. */
  router.post('/api/community/conversations', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const body = await readJson(ctx.req);
    const recipientId = requiredString(body.recipientId, 'Recipient', { max: 64 });
    if (recipientId === auth.userId) throw badRequest('You cannot message yourself.', 'Recipient');

    const pairKey = [auth.userId, recipientId].sort().join(':');
    let conversation = await ctx.db.get<{ id: string }>(
      `SELECT id FROM conversations WHERE customer_id = ? AND pair_key = ?`,
      [auth.customerId, pairKey],
    );
    if (!conversation) {
      if (!(await recipientIsAvailable(ctx, recipientId, auth.customerId))) {
        throw forbidden('That member is not available to message.');
      }
      await enforceRateLimit(ctx.db, `new-conversation:${auth.userId}`, {
        limit: 20,
        windowSeconds: 3600,
        message: 'You have started a lot of conversations recently. Please try again later.',
      });
      const timestamp = nowIso();
      await ctx.db.run(
        `INSERT OR IGNORE INTO conversations (id, customer_id, pair_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        [newId(), auth.customerId, pairKey, auth.userId, timestamp],
      );
      conversation = await ctx.db.get<{ id: string }>(
        `SELECT id FROM conversations WHERE customer_id = ? AND pair_key = ?`,
        [auth.customerId, pairKey],
      );
      await ctx.db.batch(
        [auth.userId, recipientId].map((userId) => ({
          sql: `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, customer_id, last_read_at)
                VALUES (?, ?, ?, ?)`,
          params: [conversation!.id, userId, auth.customerId, userId === auth.userId ? timestamp : null] as SqlParam[],
        })),
      );
    }
    return jsonResponse({ conversationId: conversation!.id });
  });

  /** Newest page first; pass `before` (the oldest loaded message's cursor) for older history. */
  router.get('/api/community/conversations/:id/messages', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const participant = await requireParticipant(ctx, ctx.params.id!, auth.userId);
    const limit = positiveInt(ctx.query.get('limit'), 30, 100);

    const where = ['m.conversation_id = ?'];
    const params: SqlParam[] = [participant.id];
    const before = ctx.query.get('before');
    if (before) {
      const [createdAt, id] = before.split('|');
      if (!createdAt || !id) throw badRequest('Invalid cursor.');
      where.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
      params.push(createdAt, createdAt, id);
    }
    const rows = await ctx.db.all<Record<string, unknown>>(
      `SELECT m.* FROM messages m WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    const people = await participantsById(ctx, [participant.other_id]);
    return jsonResponse({
      conversationId: participant.id,
      other: people.get(participant.other_id) ?? null,
      messages: page.reverse().map((row) => messageOut(row, auth.userId)),
      olderCursor: rows.length > limit && oldest ? `${String(oldest.created_at)}|${String(oldest.id)}` : null,
    });
  });

  router.post('/api/community/conversations/:id/messages', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const participant = await requireParticipant(ctx, ctx.params.id!, auth.userId);
    const body = await readJson(ctx.req);
    const text = messageBody(body.body);
    const kind = oneOf(body.kind, 'Kind', MESSAGE_KINDS, 'text');
    const clientKey =
      typeof body.clientKey === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.clientKey) ? body.clientKey : newId();

    // A retried send (same client key) returns the original instead of a duplicate.
    const existing = await ctx.db.get<Record<string, unknown>>(
      `SELECT * FROM messages WHERE sender_id = ? AND client_key = ?`,
      [auth.userId, clientKey],
    );
    if (existing) {
      if (String(existing.conversation_id) !== participant.id) throw conflict('That message key was already used.');
      return jsonResponse({ message: messageOut(existing, auth.userId), duplicate: true });
    }

    if (!(await recipientIsAvailable(ctx, participant.other_id, auth.customerId))) {
      throw forbidden('This member is no longer active in the community, so new messages cannot be sent.');
    }

    const recent = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM messages WHERE sender_id = ? AND created_at > ?`,
      [auth.userId, new Date(Date.now() - 60_000).toISOString()],
    );
    if (Number(recent?.total ?? 0) >= SENDS_PER_MINUTE) {
      throw tooManyRequests('You are sending messages very quickly. Please wait a moment.');
    }

    const id = newId();
    const timestamp = nowIso();
    await ctx.db.batch([
      {
        sql: `INSERT OR IGNORE INTO messages (id, customer_id, conversation_id, sender_id, body, kind, client_key, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, auth.customerId, participant.id, auth.userId, text, kind, clientKey, timestamp],
      },
      { sql: `UPDATE conversations SET last_message_at = ? WHERE id = ?`, params: [timestamp, participant.id] },
      {
        sql: `UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?`,
        params: [timestamp, participant.id, auth.userId],
      },
    ]);
    const saved = await ctx.db.get<Record<string, unknown>>(
      `SELECT * FROM messages WHERE sender_id = ? AND client_key = ?`,
      [auth.userId, clientKey],
    );
    return jsonResponse({ message: messageOut(saved!, auth.userId), duplicate: String(saved!.id) !== id }, { status: 201 });
  });

  router.post('/api/community/conversations/:id/read', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const participant = await requireParticipant(ctx, ctx.params.id!, auth.userId);
    await ctx.db.run(`UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?`, [
      nowIso(),
      participant.id,
      auth.userId,
    ]);
    return jsonResponse({ ok: true });
  });
}
