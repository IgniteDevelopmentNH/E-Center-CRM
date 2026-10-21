import type { Db } from '../db/driver.ts';
import { bufToHex } from './encoding.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';

/**
 * Single-use, expiring tokens delivered by email (verify an address, reset a
 * password, confirm a new address). Like sessions, only a SHA-256 hash is
 * stored, and each token records the exact address it was sent to, so a link
 * cannot be replayed against a different address.
 */

export type TokenPurpose = 'verify_email' | 'reset_password' | 'change_email';

const TTL_SECONDS: Record<TokenPurpose, number> = {
  verify_email: 60 * 60 * 48,
  reset_password: 60 * 60,
  change_email: 60 * 60 * 24,
};

async function hash(token: string): Promise<string> {
  return bufToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

export async function issueToken(
  db: Db,
  input: { userId: string; customerId: string; purpose: TokenPurpose; email: string },
): Promise<string> {
  const token = bufToHex(crypto.getRandomValues(new Uint8Array(32)));
  const timestamp = nowIso();
  // Issuing a new link invalidates any earlier unused link for the same purpose.
  await db.batch([
    {
      sql: `UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL`,
      params: [timestamp, input.userId, input.purpose],
    },
    {
      sql: `INSERT INTO auth_tokens (id, user_id, customer_id, purpose, token_hash, email, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        newId(),
        input.userId,
        input.customerId,
        input.purpose,
        await hash(token),
        input.email,
        new Date(Date.now() + TTL_SECONDS[input.purpose] * 1000).toISOString(),
        timestamp,
      ],
    },
  ]);
  return token;
}

export interface ConsumedToken {
  id: string;
  userId: string;
  customerId: string;
  email: string;
}

/**
 * Atomically claims a token: the UPDATE only succeeds for an unused, unexpired
 * row, so two concurrent clicks cannot both consume it.
 */
export async function consumeToken(db: Db, token: string, purpose: TokenPurpose): Promise<ConsumedToken | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = await hash(token);
  const row = await db.get<{ id: string; user_id: string; customer_id: string; email: string }>(
    `SELECT id, user_id, customer_id, email FROM auth_tokens
      WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
    [tokenHash, purpose, nowIso()],
  );
  if (!row) return null;
  const claimed = await db.get<{ id: string }>(
    `UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING id`,
    [nowIso(), row.id],
  );
  if (!claimed) return null;
  return { id: row.id, userId: row.user_id, customerId: row.customer_id, email: row.email };
}

/**
 * Looks up a token that has ALREADY been used. Lets a link that is opened a
 * second time (a double click, an email app's preview, a security scanner
 * that opened it first) report "already confirmed" instead of an error.
 * Never consumes anything and never returns an unused token.
 */
export async function findUsedToken(
  db: Db,
  token: string,
  purpose: TokenPurpose,
): Promise<{ userId: string; email: string } | null> {
  if (!token || token.length > 200) return null;
  const row = await db.get<{ user_id: string; email: string }>(
    `SELECT user_id, email FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NOT NULL`,
    [await hash(token), purpose],
  );
  return row ? { userId: row.user_id, email: row.email } : null;
}
