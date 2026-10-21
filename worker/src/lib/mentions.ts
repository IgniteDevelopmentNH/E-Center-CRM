import type { Db } from '../db/driver.ts';

/**
 * @mentions are stored inline in post/comment text as `@[Display Name](user:<uuid>)`.
 * The client inserts them from an autocomplete; the server re-validates every
 * token on save -- a token naming someone who is not an active community
 * member of this tenant is downgraded to plain "@Display Name" text, so a
 * crafted request cannot link to (or notify) arbitrary users.
 *
 * Rendering never trusts the display name for anything but text.
 */

const MENTION_RE = /@\[([^\]\n]{1,80})\]\(user:([0-9a-f-]{36})\)/gi;

export interface CleanedMentions {
  text: string;
  userIds: string[];
}

export function extractMentionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) ids.add(match[2]!.toLowerCase());
  return [...ids];
}

export async function sanitizeMentions(db: Db, customerId: string, text: string): Promise<CleanedMentions> {
  const candidates = extractMentionIds(text);
  if (!candidates.length) return { text, userIds: [] };

  const valid = new Set<string>();
  for (let i = 0; i < candidates.length; i += 90) {
    const chunk = candidates.slice(i, i + 90);
    const rows = await db.all<{ user_id: string }>(
      `SELECT ca.user_id FROM community_accounts ca JOIN users u ON u.id = ca.user_id
        WHERE ca.customer_id = ? AND ca.status = 'active' AND u.deleted_at IS NULL
          AND ca.user_id IN (${chunk.map(() => '?').join(', ')})`,
      [customerId, ...chunk],
    );
    for (const row of rows) valid.add(row.user_id.toLowerCase());
  }

  const cleaned = text.replace(MENTION_RE, (whole, name: string, id: string) =>
    valid.has(id.toLowerCase()) ? whole : `@${name}`,
  );
  return { text: cleaned, userIds: [...valid] };
}

/** Plain-text rendering for emails and previews: `@[Ana Ruiz](user:..)` -> `@Ana Ruiz`. */
export function mentionsToPlain(text: string): string {
  return text.replace(MENTION_RE, (_whole, name: string) => `@${name}`);
}

/** Records who is mentioned in a post or comment (idempotent). Returns all current mentions. */
export async function recordMentions(
  db: Db,
  input: { customerId: string; sourceType: 'post' | 'comment'; sourceId: string; userIds: string[] },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.batch([
    {
      sql: `DELETE FROM post_mentions WHERE source_type = ? AND source_id = ?`,
      params: [input.sourceType, input.sourceId],
    },
    ...input.userIds.map((userId) => ({
      sql: `INSERT OR IGNORE INTO post_mentions (source_type, source_id, user_id, customer_id, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [input.sourceType, input.sourceId, userId, input.customerId, timestamp],
    })),
  ]);
}
