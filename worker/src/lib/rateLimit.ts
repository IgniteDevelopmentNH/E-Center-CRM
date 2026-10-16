import type { Db } from '../db/driver.ts';
import { tooManyRequests } from './http.ts';
import { newId } from './ids.ts';

/**
 * Basic fixed-window rate limiting backed by D1 -- adequate for the low volume
 * of signups, password resets and new conversations here, with no extra
 * service. (Message sends are limited by counting the messages table itself.)
 */
export async function enforceRateLimit(
  db: Db,
  bucket: string,
  { limit, windowSeconds, message }: { limit: number; windowSeconds: number; message?: string },
): Promise<void> {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = await db.get<{ total: unknown }>(
    `SELECT COUNT(*) AS total FROM rate_limit_events WHERE bucket = ? AND created_at > ?`,
    [bucket, since],
  );
  if (Number(row?.total ?? 0) >= limit) throw tooManyRequests(message);

  await db.run(`INSERT INTO rate_limit_events (id, bucket, created_at) VALUES (?, ?, ?)`, [
    newId(),
    bucket,
    new Date().toISOString(),
  ]);
  // Opportunistic cleanup; correctness never depends on it.
  if (Math.random() < 0.02) {
    await db.run(`DELETE FROM rate_limit_events WHERE created_at < ?`, [
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
    ]);
  }
}
