import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.ts';
import { env } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, route, unauthorized } from '../lib/http.ts';
import { signToken } from '../lib/jwt.ts';
import { nowIso } from '../lib/time.ts';
import { requiredEmail, requiredString } from '../lib/validate.ts';
import { auth, requireAuth } from '../middleware/auth.ts';

export const authRouter = Router();

interface UserRow {
  id: string;
  customer_id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
}

authRouter.post(
  '/login',
  route(async (req, res) => {
    const email = requiredEmail(req.body?.email);
    const password = requiredString(req.body?.password, 'Password', { max: 200 });
    const remember = req.body?.remember === true;

    const db = await getDb();
    const user = await db.get<UserRow>(
      `SELECT id, customer_id, email, password_hash, name, role
         FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL`,
      [email],
    );

    // Same generic message either way, so the response cannot be used to
    // enumerate which addresses have accounts.
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      if (user) {
        await audit(db, {
          customerId: user.customer_id,
          userId: user.id,
          action: 'auth.login_failed',
          req,
        });
      }
      throw unauthorized('That email and password do not match.');
    }

    await db.run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [nowIso(), user.id]);
    await audit(db, {
      customerId: user.customer_id,
      userId: user.id,
      action: 'auth.login',
      req,
    });

    const token = signToken(
      {
        sub: user.id,
        cid: user.customer_id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      remember ? env.jwtTtlRememberSeconds : env.jwtTtlSeconds,
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  route(async (req, res) => {
    const { userId } = auth(req);
    const db = await getDb();
    const user = await db.get(
      `SELECT u.id, u.email, u.name, u.role, u.last_login_at, c.name AS customer_name, c.slug AS customer_slug
         FROM users u JOIN customers c ON c.id = u.customer_id
        WHERE u.id = ? AND u.deleted_at IS NULL`,
      [userId],
    );
    if (!user) throw unauthorized();
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        lastLoginAt: user.last_login_at,
      },
      customer: { name: user.customer_name, slug: user.customer_slug },
    });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  route(async (req, res) => {
    const { userId, customerId } = auth(req);
    const current = requiredString(req.body?.currentPassword, 'Current password', { max: 200 });
    const next = requiredString(req.body?.newPassword, 'New password', { max: 200 });
    if (next.length < 8) throw badRequest('New password must be at least 8 characters.', 'New password');

    const db = await getDb();
    const user = await db.get<UserRow>(`SELECT id, password_hash FROM users WHERE id = ?`, [userId]);
    if (!user || !(await bcrypt.compare(current, user.password_hash))) {
      throw badRequest('Your current password is incorrect.', 'Current password');
    }

    await db.run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
      await bcrypt.hash(next, 12),
      nowIso(),
      userId,
    ]);
    await audit(db, {
      customerId,
      userId,
      action: 'user.update',
      entityType: 'user',
      entityId: userId,
      metadata: { change: 'password' },
      req,
    });
    res.json({ ok: true });
  }),
);
