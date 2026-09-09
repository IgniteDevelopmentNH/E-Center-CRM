import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.ts';
import { env } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound, route } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso, todayDate } from '../lib/time.ts';
import { oneOf, positiveInt, requiredEmail, requiredString } from '../lib/validate.ts';
import { auth, requireAuth, requireEditor, requireOwner } from '../middleware/auth.ts';
import { ALLOWED_TYPES } from '../services/storage.ts';
import { USER_ROLES, userOut } from '../records.ts';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const DIGEST_OPTIONS = ['off', 'daily', 'weekly'] as const;

/** Team roster. Every signed-in user can read it -- the assignee pickers need it. */
settingsRouter.get(
  '/users',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const rows = await db.all(
      `SELECT u.id, u.email, u.name, u.role, u.last_login_at, u.created_at,
              (SELECT COUNT(*) FROM tasks t
                WHERE t.assigned_to = u.id AND t.deleted_at IS NULL AND t.status <> 'complete')
                AS open_task_count
         FROM users u
        WHERE u.customer_id = ? AND u.deleted_at IS NULL
        ORDER BY LOWER(u.name) ASC`,
      [customerId],
    );
    res.json({ users: rows.map(userOut) });
  }),
);

settingsRouter.post(
  '/users',
  requireOwner,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = requiredEmail(body.email);
    const name = requiredString(body.name, 'Name', { max: 120 });
    const role = oneOf(body.role, 'Role', USER_ROLES, 'editor');
    const password = requiredString(body.password, 'Temporary password', { max: 200 });
    if (password.length < 8) {
      throw badRequest('The temporary password must be at least 8 characters.', 'Temporary password');
    }

    const db = await getDb();
    const clash = await db.get(`SELECT id FROM users WHERE LOWER(email) = ?`, [email]);
    if (clash) throw badRequest('An account with that email already exists.', 'Email');

    const id = newId();
    const timestamp = nowIso();
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO users (id, customer_id, email, password_hash, name, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, customerId, email, await bcrypt.hash(password, 12), name, role, timestamp, timestamp],
      );
      await tx.run(
        `INSERT INTO user_preferences (user_id, customer_id, updated_at) VALUES (?, ?, ?)`,
        [id, customerId, timestamp],
      );
    });

    await audit(db, {
      customerId,
      userId,
      action: 'user.create',
      entityType: 'user',
      entityId: id,
      metadata: { email, role },
      req,
    });

    const row = await db.get(`SELECT id, email, name, role, last_login_at, created_at FROM users WHERE id = ?`, [id]);
    res.status(201).json({ user: userOut(row!) });
  }),
);

settingsRouter.put(
  '/users/:id',
  requireOwner,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get<{ id: string; role: string }>(
      `SELECT id, role FROM users WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That team member no longer exists.');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = requiredString(body.name, 'Name', { max: 120 });
    const role = oneOf(body.role, 'Role', USER_ROLES, 'editor');

    // Do not allow the last owner to demote themselves out of the account.
    if (existing.role === 'owner' && role !== 'owner') {
      const owners = await db.get<{ total: unknown }>(
        `SELECT COUNT(*) AS total FROM users
          WHERE customer_id = ? AND role = 'owner' AND deleted_at IS NULL`,
        [customerId],
      );
      if (Number(owners?.total ?? 0) <= 1) {
        throw badRequest('The account needs at least one owner.', 'Role');
      }
    }

    await db.run(`UPDATE users SET name = ?, role = ?, updated_at = ? WHERE id = ? AND customer_id = ?`, [
      name,
      role,
      nowIso(),
      req.params.id!,
      customerId,
    ]);
    await audit(db, {
      customerId,
      userId,
      action: 'user.update',
      entityType: 'user',
      entityId: req.params.id!,
      metadata: { name, role },
      req,
    });

    const row = await db.get(`SELECT id, email, name, role, last_login_at, created_at FROM users WHERE id = ?`, [
      req.params.id!,
    ]);
    res.json({ user: userOut(row!) });
  }),
);

settingsRouter.delete(
  '/users/:id',
  requireOwner,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    if (req.params.id === userId) throw badRequest('You cannot remove your own account.');

    const db = await getDb();
    const existing = await db.get<{ email: string; role: string }>(
      `SELECT email, role FROM users WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That team member no longer exists.');

    const timestamp = nowIso();
    await db.tx(async (tx) => {
      await tx.run(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ? AND customer_id = ?`, [
        timestamp,
        timestamp,
        req.params.id!,
        customerId,
      ]);
      // Their open work stays visible to the team rather than disappearing.
      await tx.run(
        `UPDATE tasks SET assigned_to = NULL, updated_at = ?
          WHERE assigned_to = ? AND customer_id = ? AND status <> 'complete'`,
        [timestamp, req.params.id!, customerId],
      );
    });

    await audit(db, {
      customerId,
      userId,
      action: 'user.delete',
      entityType: 'user',
      entityId: req.params.id!,
      metadata: { email: existing.email },
      req,
    });
    res.json({ ok: true });
  }),
);

/** Preferences, tenant identity and the effective server configuration. */
settingsRouter.get(
  '/',
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();

    const preferences = await db.get(`SELECT * FROM user_preferences WHERE user_id = ?`, [userId]);
    const customer = await db.get<{ name: string; slug: string; created_at: string }>(
      `SELECT name, slug, created_at FROM customers WHERE id = ?`,
      [customerId],
    );
    const sync = await db.get(`SELECT * FROM calendar_sync_metadata WHERE customer_id = ?`, [customerId]);
    const credentials = await db.get<{ account_email: string | null; refresh_token_enc: string | null }>(
      `SELECT account_email, refresh_token_enc FROM microsoft_oauth_credentials WHERE customer_id = ?`,
      [customerId],
    );

    res.json({
      preferences: {
        emailDigest: String(preferences?.email_digest ?? 'off'),
        reminderLeadDays: Number(preferences?.reminder_lead_days ?? 1),
        timezone: String(preferences?.timezone ?? 'America/New_York'),
      },
      customer: {
        name: customer?.name ?? '',
        slug: customer?.slug ?? '',
        createdAt: customer?.created_at ?? null,
      },
      calendar: {
        configured: !!credentials,
        connected: !!credentials?.refresh_token_enc,
        accountEmail: credentials?.account_email ?? null,
        lastSyncAt: sync?.last_sync_at ?? null,
        syncStatus: sync?.sync_status ?? 'never',
        errorMessage: sync?.error_message ?? null,
        eventsPulled: Number(sync?.events_pulled ?? 0),
        eventsPushed: Number(sync?.events_pushed ?? 0),
      },
      documents: {
        storageDriver: env.storageDriver,
        maxFileSizeMb: Math.round(env.uploadMaxBytes / (1024 * 1024)),
        allowedExtensions: [...new Set(Object.values(ALLOWED_TYPES).flat())].sort(),
        downloadUrlTtlMinutes: Math.round(env.downloadUrlTtlSeconds / 60),
      },
      about: {
        version: '1.0.0',
        databaseDriver: env.dbDriver,
        serverDate: todayDate(),
      },
    });
  }),
);

settingsRouter.put(
  '/preferences',
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const emailDigest = oneOf(body.emailDigest, 'Email digest', DIGEST_OPTIONS, 'off');
    const reminderLeadDays = positiveInt(body.reminderLeadDays, 1, 30);
    const timezone = requiredString(body.timezone, 'Timezone', { max: 60 });

    const db = await getDb();
    const existing = await db.get(`SELECT user_id FROM user_preferences WHERE user_id = ?`, [userId]);
    if (existing) {
      await db.run(
        `UPDATE user_preferences
            SET email_digest = ?, reminder_lead_days = ?, timezone = ?, updated_at = ?
          WHERE user_id = ?`,
        [emailDigest, reminderLeadDays, timezone, nowIso(), userId],
      );
    } else {
      await db.run(
        `INSERT INTO user_preferences
           (user_id, customer_id, email_digest, reminder_lead_days, timezone, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, customerId, emailDigest, reminderLeadDays, timezone, nowIso()],
      );
    }

    res.json({ preferences: { emailDigest, reminderLeadDays, timezone } });
  }),
);

/** Compliance view: recent sensitive operations. */
settingsRouter.get(
  '/audit-logs',
  requireEditor,
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const limit = positiveInt(req.query.limit, 50, 200);
    const rows = await db.all(
      `SELECT a.*, u.name AS user_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.customer_id = ?
        ORDER BY a.created_at DESC LIMIT ?`,
      [customerId, limit],
    );
    res.json({
      logs: rows.map((row) => ({
        id: String(row.id),
        action: String(row.action),
        entityType: row.entity_type ?? null,
        entityId: row.entity_id ?? null,
        userName: row.user_name ?? null,
        metadata: row.metadata ? String(row.metadata) : null,
        ipAddress: row.ip_address ?? null,
        createdAt: row.created_at,
      })),
    });
  }),
);
