import type { Db } from '../db/driver.ts';
import { HttpError } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';

/**
 * When staff remove (deactivate) a member, their email is blocked so the same
 * person cannot simply sign up again. Staff can undo it from Admin > Settings
 * > Blocked users, which also restores the account.
 */

export async function isEmailBlocked(db: Db, customerId: string, email: string): Promise<boolean> {
  const row = await db.get(`SELECT 1 AS blocked FROM blocked_emails WHERE customer_id = ? AND email = ?`, [
    customerId,
    email.trim().toLowerCase(),
  ]);
  return !!row;
}

export async function assertEmailNotBlocked(db: Db, customerId: string, email: string, field = 'Email'): Promise<void> {
  if (await isEmailBlocked(db, customerId, email)) {
    throw new HttpError(
      403,
      'This email address cannot be used to join the ECenter community. Contact the ECenter if you think this is a mistake.',
      field,
    );
  }
}

export async function blockEmail(
  db: Db,
  input: { customerId: string; email: string; userId: string | null; reason: string | null; blockedBy: string },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO blocked_emails (id, customer_id, email, user_id, reason, blocked_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId(), input.customerId, input.email.trim().toLowerCase(), input.userId, input.reason, input.blockedBy, nowIso()],
  );
}

export async function unblockUser(db: Db, customerId: string, userId: string): Promise<void> {
  await db.run(`DELETE FROM blocked_emails WHERE customer_id = ? AND user_id = ?`, [customerId, userId]);
}
