import type { Db } from '../db/driver.ts';
import { bufToHex } from './encoding.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';

/**
 * DB-backed sessions. A bearer token is an opaque random string; only its
 * SHA-256 hash is stored, so a database dump does not hand out live sessions.
 * Verifying a session joins straight through to `users`, so a soft-deleted or
 * removed team member loses access on their very next request -- a stateless
 * JWT could not do that without a separate deny-list.
 */

export interface SessionUser {
  sessionId: string;
  userId: string;
  customerId: string;
  email: string;
  name: string;
  role: string;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bufToHex(digest);
}

function randomToken(): string {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createSession(
  db: Db,
  input: { userId: string; customerId: string },
  ttlSeconds: number,
): Promise<string> {
  const token = randomToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await db.run(
    `INSERT INTO sessions (id, token_hash, user_id, customer_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), await hashToken(token), input.userId, input.customerId, expiresAt, timestamp],
  );
  return token;
}

export async function getSessionUser(db: Db, token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await db.get<{
    session_id: string;
    user_id: string;
    customer_id: string;
    email: string;
    name: string;
    role: string;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.customer_id AS customer_id,
            u.email AS email, u.name AS name, u.role AS role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL`,
    [await hashToken(token), nowIso()],
  );
  if (!row) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    customerId: row.customer_id,
    email: row.email,
    name: row.name,
    role: row.role,
  };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.run(`DELETE FROM sessions WHERE token_hash = ?`, [await hashToken(token)]);
}

/** Used when a team member is removed, so their access ends immediately. */
export async function revokeAllSessionsForUser(db: Db, userId: string): Promise<void> {
  await db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

/** Opportunistic cleanup; safe to call occasionally, never required for correctness. */
export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.run(`DELETE FROM sessions WHERE expires_at <= ?`, [nowIso()]);
}
