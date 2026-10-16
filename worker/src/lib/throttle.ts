import type { Db } from '../db/driver.ts';
import { HttpError } from './http.ts';
import { nowIso } from './time.ts';

/**
 * Brute-force protection for sign-in. Failures are counted per attempted email
 * and per client IP inside a rolling window; crossing the limit locks that key
 * until `locked_until`. The email key is counted whether or not the account
 * exists, so the response never hints at which addresses are real.
 */

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const LIMITS = { email: 5, ip: 20 } as const;

interface ThrottleRow {
  key: string;
  failures: number;
  window_started_at: string;
  locked_until: string | null;
}

export function throttleKeys(email: string, ip: string): { key: string; limit: number }[] {
  const keys: { key: string; limit: number }[] = [{ key: `email:${email.toLowerCase()}`, limit: LIMITS.email }];
  if (ip) keys.push({ key: `ip:${ip}`, limit: LIMITS.ip });
  return keys;
}

/** Throws 429 (with Retry-After) if any key is currently locked. */
export async function assertNotLocked(db: Db, keys: { key: string }[]): Promise<void> {
  const now = nowIso();
  for (const { key } of keys) {
    const row = await db.get<ThrottleRow>(`SELECT * FROM login_throttle WHERE key = ?`, [key]);
    if (row?.locked_until && row.locked_until > now) {
      const seconds = Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000));
      throw new HttpError(
        429,
        'Too many failed sign-in attempts. Please wait a few minutes and try again.',
        undefined,
        { 'Retry-After': String(seconds) },
      );
    }
  }
}

export async function recordFailure(db: Db, keys: { key: string; limit: number }[]): Promise<void> {
  const now = Date.now();
  for (const { key, limit } of keys) {
    const row = await db.get<ThrottleRow>(`SELECT * FROM login_throttle WHERE key = ?`, [key]);
    const windowExpired = !row || now - Date.parse(row.window_started_at) > WINDOW_MS;
    const failures = windowExpired ? 1 : row.failures + 1;
    const windowStart = windowExpired ? new Date(now).toISOString() : row.window_started_at;
    const lockedUntil = failures >= limit ? new Date(now + LOCK_MS).toISOString() : null;
    await db.run(
      `INSERT INTO login_throttle (key, failures, window_started_at, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
         window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`,
      [key, failures, windowStart, lockedUntil],
    );
  }
}

export async function clearFailures(db: Db, email: string): Promise<void> {
  await db.run(`DELETE FROM login_throttle WHERE key = ?`, [`email:${email.toLowerCase()}`]);
}
