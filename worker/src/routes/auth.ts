import { audit } from '../lib/audit.ts';
import { badRequest, clientIp, jsonResponse, readJson, unauthorized } from '../lib/http.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { createSession, revokeOtherSessions, revokeSession } from '../lib/session.ts';
import { assertNotLocked, clearFailures, recordFailure, throttleKeys } from '../lib/throttle.ts';
import { nowIso } from '../lib/time.ts';
import { requiredEmail, requiredString } from '../lib/validate.ts';
import { requireAuth } from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';

interface UserRow {
  id: string;
  customer_id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
}

// Valid-format hash of a random password; only ever compared against, to equalise timing.
const DUMMY_HASH =
  'pbkdf2:100000:00112233445566778899aabbccddeeff:0000000000000000000000000000000000000000000000000000000000000000';

export function register(router: Router): void {
  router.post('/api/auth/login', async (ctx: Ctx) => {
    const body = await readJson(ctx.req);
    const email = requiredEmail(body.email);
    const password = requiredString(body.password, 'Password', { max: 200 });
    const remember = body.remember === true;

    const keys = throttleKeys(email, clientIp(ctx.req));
    await assertNotLocked(ctx.db, keys);

    const user = await ctx.db.get<UserRow>(
      `SELECT id, customer_id, email, password_hash, name, role
         FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL`,
      [email],
    );

    // Same generic message either way, so the response cannot be used to
    // enumerate which addresses have accounts. When the account does not
    // exist we still run a full hash so response time does not give it away.
    const passwordOk = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !passwordOk) {
      await recordFailure(ctx.db, keys);
      if (user) {
        await audit(ctx.db, {
          customerId: user.customer_id,
          userId: user.id,
          action: 'auth.login_failed',
          req: ctx.req,
        });
      }
      throw unauthorized('That email and password do not match.');
    }

    await clearFailures(ctx.db, email);
    await ctx.db.run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [nowIso(), user.id]);
    await audit(ctx.db, { customerId: user.customer_id, userId: user.id, action: 'auth.login', req: ctx.req });

    const ttl = remember ? ctx.config.sessionTtlRememberSeconds : ctx.config.sessionTtlSeconds;
    const token = await createSession(ctx.db, { userId: user.id, customerId: user.customer_id }, ttl);

    return jsonResponse({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });

  router.get('/api/auth/me', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const user = await ctx.db.get<Record<string, unknown>>(
      `SELECT u.id, u.email, u.name, u.role, u.last_login_at, c.name AS customer_name, c.slug AS customer_slug
         FROM users u JOIN customers c ON c.id = u.customer_id
        WHERE u.id = ? AND u.deleted_at IS NULL`,
      [auth.userId],
    );
    if (!user) throw unauthorized();
    return jsonResponse({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        lastLoginAt: user.last_login_at,
      },
      customer: { name: user.customer_name, slug: user.customer_slug },
    });
  });

  /** New in the Worker rewrite: a DB-backed session can actually be revoked. */
  router.post('/api/auth/logout', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (ctx.token) await revokeSession(ctx.db, ctx.token);
    await audit(ctx.db, { customerId: auth.customerId, userId: auth.userId, action: 'auth.logout', req: ctx.req });
    return jsonResponse({ ok: true });
  });

  router.post('/api/auth/change-password', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson(ctx.req);
    const current = requiredString(body.currentPassword, 'Current password', { max: 200 });
    const next = requiredString(body.newPassword, 'New password', { max: 200 });
    if (next.length < 10) throw badRequest('New password must be at least 10 characters.', 'New password');

    const user = await ctx.db.get<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM users WHERE id = ?`,
      [auth.userId],
    );
    if (!user || !(await verifyPassword(current, user.password_hash))) {
      throw badRequest('Your current password is incorrect.', 'Current password');
    }

    await ctx.db.run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
      await hashPassword(next),
      nowIso(),
      auth.userId,
    ]);
    // A changed password should end every other signed-in session (e.g. a
    // stolen or forgotten device) while keeping this one.
    if (ctx.token) await revokeOtherSessions(ctx.db, auth.userId, ctx.token);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'user.update',
      entityType: 'user',
      entityId: auth.userId,
      metadata: { change: 'password' },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });
}
