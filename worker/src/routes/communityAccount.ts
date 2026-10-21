import type { Db } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { consumeToken, findUsedToken, issueToken } from '../lib/authTokens.ts';
import {
  normaliseEmail,
  optionalGraduationYear,
  optionalLinkedInUrl,
  optionalSchedulingUrl,
  password as passwordField,
} from '../lib/communityValidate.ts';
import { badRequest, clientIp, conflict, forbidden, isUniqueViolation, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { actionEmail, appBaseUrl, sendMail } from '../lib/mailer.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { enforceRateLimit } from '../lib/rateLimit.ts';
import { createSession, revokeAllSessionsForUser } from '../lib/session.ts';
import { signValue } from '../lib/signedToken.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, optionalString, requiredEmail, requiredString } from '../lib/validate.ts';
import {
  getCommunityAccount,
  requireOwnCommunityAccount,
  requireSession,
  requireStaff,
} from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';
import {
  ACCOUNT_TYPES,
  ensureDefaultTags,
  finalizeAccount,
  loadTags,
  photoUrl,
  replaceTagWrites,
} from '../services/community.ts';
import {
  PREFERENCE_COLUMNS,
  readUnsubscribeToken,
} from '../services/notifications.ts';
import type { PreferenceKind } from '../services/notifications.ts';
import { effectivePostPermission } from '../services/posts.ts';
import { storeCommunityUpload } from '../services/communityFiles.ts';
import { deleteObject } from '../services/storage.ts';

const MAX_TAGS_PER_KIND = 10;

/* ------------------------------------------------------------- helpers -- */

async function defaultCustomerId(ctx: Ctx): Promise<string> {
  const customer = await ctx.db.get<{ id: string }>(
    `SELECT id FROM customers WHERE slug = ? AND deleted_at IS NULL`,
    [ctx.config.defaultCustomer.slug],
  );
  if (!customer) throw badRequest('Community signup is not available yet. Please contact the ECenter.');
  return customer.id;
}

/** The signed-in person's own community state: private, never shown to others. */
export async function ownCommunityState(ctx: Ctx, userId: string) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `SELECT ca.account_type, ca.status, ca.onboarding_completed_at, ca.link_state,
            ca.resume_name, ca.resume_size, ca.resume_uploaded_at, ca.resume_public,
            ca.post_permission, ca.notify_messages, ca.notify_mentions, ca.notify_announcements,
            u.email, u.email_verified_at, u.role,
            p.first_name, p.last_name, p.bio, p.linkedin_url, p.photo_key, p.major, p.graduation_year,
            p.role_title, p.company, p.scheduling_url,
            (SELECT t.email FROM auth_tokens t
              WHERE t.user_id = u.id AND t.purpose = 'change_email' AND t.used_at IS NULL AND t.expires_at > ?
              ORDER BY t.created_at DESC LIMIT 1) AS pending_email
       FROM community_accounts ca
       JOIN users u ON u.id = ca.user_id
       JOIN community_profiles p ON p.user_id = ca.user_id
      WHERE ca.user_id = ?`,
    [nowIso(), userId],
  );
  if (!row) return null;
  const tags = (await loadTags(ctx.db, [userId])).get(userId);
  return {
    userId,
    accountType: String(row.account_type),
    status: String(row.status),
    onboardingCompleted: !!row.onboarding_completed_at,
    emailVerified: !!row.email_verified_at,
    email: String(row.email),
    pendingEmail: row.pending_email ? String(row.pending_email) : null,
    profile: {
      firstName: String(row.first_name),
      lastName: String(row.last_name),
      bio: row.bio ? String(row.bio) : null,
      linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : null,
      photoUrl: await photoUrl(ctx, userId, row.photo_key),
      major: row.major ? String(row.major) : null,
      graduationYear: row.graduation_year ? Number(row.graduation_year) : null,
      roleTitle: row.role_title ? String(row.role_title) : null,
      company: row.company ? String(row.company) : null,
      schedulingUrl: row.scheduling_url ? String(row.scheduling_url) : null,
      interests: tags?.interests ?? [],
      help: tags?.help ?? [],
    },
    resume: row.resume_name
      ? {
          fileName: String(row.resume_name),
          size: Number(row.resume_size ?? 0),
          uploadedAt: String(row.resume_uploaded_at),
          public: Number(row.resume_public) === 1,
        }
      : null,
    // What this person may do with posts (see services/posts.ts).
    postPermission: effectivePostPermission(String(row.account_type), row.post_permission as string | null, String(row.role)),
    notifications: {
      messages: Number(row.notify_messages) === 1,
      mentions: Number(row.notify_mentions) === 1,
      announcements: Number(row.notify_announcements) === 1,
    },
  };
}

async function sendVerificationEmail(
  ctx: Ctx,
  user: { id: string; customerId: string; email: string; firstName: string },
): Promise<boolean> {
  const token = await issueToken(ctx.db, {
    userId: user.id,
    customerId: user.customerId,
    purpose: 'verify_email',
    email: user.email,
  });
  return sendMail(
    ctx,
    actionEmail({
      to: user.email,
      subject: 'Confirm your email for the UNH ECenter community',
      greeting: `Hi ${user.firstName},`,
      intro: 'Please confirm this is your email address to finish creating your UNH ECenter community account.',
      actionLabel: 'Confirm my email',
      url: `${appBaseUrl(ctx)}/verify-email?token=${encodeURIComponent(token)}`,
      outro: 'This link expires in 48 hours. If you did not sign up, you can ignore this email.',
    }),
  );
}

/** Resolves submitted tag slugs to ids, rejecting anything outside the shared taxonomy. */
async function tagIdsFor(db: Db, customerId: string, value: unknown, field: string): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list.`, field);
  const slugs = [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length <= 80))];
  if (slugs.length > MAX_TAGS_PER_KIND) throw badRequest(`Choose up to ${MAX_TAGS_PER_KIND} ${field.toLowerCase()}.`, field);
  if (!slugs.length) return [];
  const rows = await db.all<{ id: string; slug: string }>(
    `SELECT id, slug FROM interest_tags WHERE customer_id = ? AND slug IN (${slugs.map(() => '?').join(', ')})`,
    [customerId, ...slugs],
  );
  if (rows.length !== slugs.length) throw badRequest(`${field} contains an unknown topic.`, field);
  return rows.map((row) => row.id);
}

/* -------------------------------------------------------------- routes -- */

export function register(router: Router): void {
  /** Shared public interest/expertise taxonomy for pickers and filters. */
  router.get('/api/community/tags', async (ctx: Ctx) => {
    const auth = ctx.auth;
    const customerId = auth?.customerId ?? (await defaultCustomerId(ctx));
    await ensureDefaultTags(ctx.db, customerId);
    const rows = await ctx.db.all<{ slug: string; label: string; featured: number }>(
      `SELECT slug, label, featured FROM interest_tags WHERE customer_id = ? ORDER BY label ASC`,
      [customerId],
    );
    return jsonResponse({ tags: rows.map((row) => ({ slug: row.slug, label: row.label, featured: Number(row.featured) === 1 })) });
  });

  /**
   * Step 1 of onboarding. Creates a pending member login, its community
   * account and public profile, signs them in, and emails a verification
   * link. Re-submitting with the same email and password while the account is
   * still pending RESUMES that signup instead of failing or duplicating it.
   */
  router.post('/api/community/signup', async (ctx: Ctx) => {
    const body = await readJson(ctx.req);
    const accountType = oneOf(body.accountType, 'Account type', ACCOUNT_TYPES);
    const firstName = requiredString(body.firstName, 'First name', { max: 80 });
    const lastName = requiredString(body.lastName, 'Last name', { max: 80 });
    const email = normaliseEmail(requiredEmail(body.email));
    const password = passwordField(body.password);

    await enforceRateLimit(ctx.db, `signup:ip:${clientIp(ctx.req) || 'unknown'}`, { limit: 20, windowSeconds: 3600 });
    const customerId = await defaultCustomerId(ctx);

    const resume = async (): Promise<string | null> => {
      const existing = await ctx.db.get<{ id: string; role: string; password_hash: string; status: string | null }>(
        `SELECT u.id, u.role, u.password_hash, ca.status
           FROM users u LEFT JOIN community_accounts ca ON ca.user_id = u.id
          WHERE LOWER(u.email) = ? AND u.deleted_at IS NULL`,
        [email],
      );
      if (!existing) return null;
      const resumable =
        existing.role === 'member' && existing.status === 'pending' && (await verifyPassword(password, existing.password_hash));
      if (!resumable) throw conflict('An account with this email already exists. Sign in instead.', 'Email');
      const timestamp = nowIso();
      await ctx.db.batch([
        {
          sql: `UPDATE community_accounts SET account_type = ?, updated_at = ? WHERE user_id = ? AND status = 'pending'`,
          params: [accountType, timestamp, existing.id],
        },
        {
          sql: `UPDATE community_profiles SET first_name = ?, last_name = ?, updated_at = ? WHERE user_id = ?`,
          params: [firstName, lastName, timestamp, existing.id],
        },
        {
          sql: `UPDATE users SET name = ?, updated_at = ? WHERE id = ?`,
          params: [`${firstName} ${lastName}`, timestamp, existing.id],
        },
      ]);
      return existing.id;
    };

    let userId = await resume();
    let created = false;
    if (!userId) {
      const id = newId();
      const timestamp = nowIso();
      try {
        await ctx.db.batch([
          {
            sql: `INSERT INTO users (id, customer_id, email, password_hash, name, role, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'member', ?, ?)`,
            params: [id, customerId, email, await hashPassword(password), `${firstName} ${lastName}`, timestamp, timestamp],
          },
          {
            sql: `INSERT INTO community_accounts (user_id, customer_id, account_type, status, link_state, created_at, updated_at)
                  VALUES (?, ?, ?, 'pending', 'pending', ?, ?)`,
            params: [id, customerId, accountType, timestamp, timestamp],
          },
          {
            sql: `INSERT INTO community_profiles (user_id, customer_id, first_name, last_name, updated_at)
                  VALUES (?, ?, ?, ?, ?)`,
            params: [id, customerId, firstName, lastName, timestamp],
          },
        ]);
        userId = id;
        created = true;
      } catch (error) {
        // A concurrent duplicate submit won the race: treat this one as a resume.
        if (!isUniqueViolation(error)) throw error;
        userId = await resume();
        if (!userId) throw error;
      }
    }

    const verified = await ctx.db.get<{ email_verified_at: string | null }>(
      `SELECT email_verified_at FROM users WHERE id = ?`,
      [userId],
    );
    let verificationEmailSent = false;
    if (!verified?.email_verified_at) {
      verificationEmailSent = await sendVerificationEmail(ctx, { id: userId, customerId, email, firstName });
    }

    if (created) {
      await audit(ctx.db, {
        customerId,
        userId,
        action: 'community.signup',
        entityType: 'user',
        entityId: userId,
        metadata: { accountType },
        req: ctx.req,
      });
    }

    const token = await createSession(ctx.db, { userId, customerId }, ctx.config.sessionTtlSeconds);
    return jsonResponse(
      {
        token,
        user: { id: userId, email, name: `${firstName} ${lastName}`, role: 'member' },
        community: await ownCommunityState(ctx, userId),
        verificationEmailSent,
        resumed: !created,
      },
      { status: created ? 201 : 200 },
    );
  });

  router.post('/api/community/verification/resend', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const user = await ctx.db.get<{ email: string; email_verified_at: string | null; first_name: string }>(
      `SELECT u.email, u.email_verified_at, p.first_name FROM users u
         JOIN community_profiles p ON p.user_id = u.id WHERE u.id = ?`,
      [auth.userId],
    );
    if (!user) throw notFound();
    if (user.email_verified_at) return jsonResponse({ ok: true, alreadyVerified: true });
    await enforceRateLimit(ctx.db, `verify-resend:${auth.userId}`, {
      limit: 3,
      windowSeconds: 900,
      message: 'We just sent a link. Please wait a few minutes before asking for another.',
    });
    const sent = await sendVerificationEmail(ctx, {
      id: auth.userId,
      customerId: auth.customerId,
      email: user.email,
      firstName: user.first_name,
    });
    return jsonResponse({ ok: sent, verificationEmailSent: sent });
  });

  /** Public: the link in the verification email. */
  router.post('/api/auth/verify-email', async (ctx: Ctx) => {
    const body = await readJson(ctx.req);
    const token = typeof body.token === 'string' ? body.token : '';
    const consumed = await consumeToken(ctx.db, token, 'verify_email');
    if (!consumed) {
      // Opened a second time: if this exact link already confirmed the address, say so.
      const used = await findUsedToken(ctx.db, token, 'verify_email');
      if (used) {
        const current = await ctx.db.get<{ email: string; email_verified_at: string | null }>(
          `SELECT email, email_verified_at FROM users WHERE id = ? AND deleted_at IS NULL`,
          [used.userId],
        );
        if (current?.email_verified_at && normaliseEmail(current.email) === normaliseEmail(used.email)) {
          return jsonResponse({ ok: true, alreadyVerified: true });
        }
      }
      throw badRequest('That link is invalid or has expired. Sign in to request a new one.');
    }

    const user = await ctx.db.get<{ email: string }>(`SELECT email FROM users WHERE id = ? AND deleted_at IS NULL`, [
      consumed.userId,
    ]);
    if (!user || normaliseEmail(user.email) !== normaliseEmail(consumed.email)) {
      throw badRequest('That link was sent to an address that is no longer on this account.');
    }
    await ctx.db.run(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`, [
      nowIso(),
      nowIso(),
      consumed.userId,
    ]);
    await audit(ctx.db, {
      customerId: consumed.customerId,
      userId: consumed.userId,
      action: 'community.email_verified',
      entityType: 'user',
      entityId: consumed.userId,
      req: ctx.req,
    });
    await finalizeAccount(ctx, consumed.userId);
    return jsonResponse({ ok: true });
  });

  /** Public: confirms a NEW address. Keeps the existing CRM link exactly as it was. */
  router.post('/api/auth/confirm-email-change', async (ctx: Ctx) => {
    const body = await readJson(ctx.req);
    const token = typeof body.token === 'string' ? body.token : '';
    const consumed = await consumeToken(ctx.db, token, 'change_email');
    if (!consumed) {
      const used = await findUsedToken(ctx.db, token, 'change_email');
      if (used) {
        const current = await ctx.db.get<{ email: string }>(`SELECT email FROM users WHERE id = ? AND deleted_at IS NULL`, [used.userId]);
        if (current && normaliseEmail(current.email) === normaliseEmail(used.email)) {
          return jsonResponse({ ok: true, alreadyVerified: true });
        }
      }
      throw badRequest('That link is invalid or has expired.');
    }

    const clash = await ctx.db.get(`SELECT id FROM users WHERE LOWER(email) = ? AND id <> ?`, [
      consumed.email,
      consumed.userId,
    ]);
    if (clash) throw conflict('That email address is already used by another account.');

    const previous = await ctx.db.get<{ email: string }>(`SELECT email FROM users WHERE id = ?`, [consumed.userId]);
    const timestamp = nowIso();
    await ctx.db.run(`UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?`, [
      consumed.email,
      timestamp,
      timestamp,
      consumed.userId,
    ]);
    await audit(ctx.db, {
      customerId: consumed.customerId,
      userId: consumed.userId,
      action: 'community.email_changed',
      entityType: 'user',
      entityId: consumed.userId,
      metadata: { from: previous?.email ?? null, to: consumed.email, crmLinkUnchanged: true },
      req: ctx.req,
    });
    // A pending, never-linked account now links using the new verified address;
    // an already-linked account keeps its contact (finalize never relinks).
    await finalizeAccount(ctx, consumed.userId);
    return jsonResponse({ ok: true });
  });

  /** Public. Always answers the same way, so it cannot reveal which addresses have accounts. */
  router.post('/api/auth/forgot-password', async (ctx: Ctx) => {
    const body = await readJson(ctx.req);
    const email = normaliseEmail(requiredEmail(body.email));
    await enforceRateLimit(ctx.db, `forgot:ip:${clientIp(ctx.req) || 'unknown'}`, { limit: 10, windowSeconds: 3600 });

    const user = await ctx.db.get<{ id: string; customer_id: string; name: string }>(
      `SELECT id, customer_id, name FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL`,
      [email],
    );
    if (user) {
      let allowed = true;
      try {
        await enforceRateLimit(ctx.db, `forgot:user:${user.id}`, { limit: 3, windowSeconds: 900 });
      } catch {
        allowed = false;
      }
      if (allowed) {
        const token = await issueToken(ctx.db, {
          userId: user.id,
          customerId: user.customer_id,
          purpose: 'reset_password',
          email,
        });
        await sendMail(
          ctx,
          actionEmail({
            to: email,
            subject: 'Reset your UNH ECenter password',
            greeting: `Hi ${user.name.split(' ')[0]},`,
            intro: 'We received a request to reset the password for your UNH ECenter account.',
            actionLabel: 'Choose a new password',
            url: `${appBaseUrl(ctx)}/reset-password?token=${encodeURIComponent(token)}`,
            outro: 'This link expires in one hour. If you did not ask for this, you can ignore this email.',
          }),
        );
        await audit(ctx.db, {
          customerId: user.customer_id,
          userId: user.id,
          action: 'auth.password_reset_requested',
          entityType: 'user',
          entityId: user.id,
          req: ctx.req,
        });
      }
    }
    return jsonResponse({ ok: true });
  });

  router.post('/api/auth/reset-password', async (ctx: Ctx) => {
    const body = await readJson(ctx.req);
    const newPassword = passwordField(body.password, 'New password');
    const consumed = await consumeToken(ctx.db, typeof body.token === 'string' ? body.token : '', 'reset_password');
    if (!consumed) throw badRequest('That reset link is invalid or has expired. Request a new one.');

    const user = await ctx.db.get<{ email: string }>(`SELECT email FROM users WHERE id = ? AND deleted_at IS NULL`, [
      consumed.userId,
    ]);
    if (!user || normaliseEmail(user.email) !== consumed.email) {
      throw badRequest('That reset link is no longer valid for this account.');
    }
    const timestamp = nowIso();
    // Following an emailed link also proves the address belongs to them.
    await ctx.db.run(
      `UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`,
      [await hashPassword(newPassword), timestamp, timestamp, consumed.userId],
    );
    await revokeAllSessionsForUser(ctx.db, consumed.userId);
    await audit(ctx.db, {
      customerId: consumed.customerId,
      userId: consumed.userId,
      action: 'auth.password_reset',
      entityType: 'user',
      entityId: consumed.userId,
      req: ctx.req,
    });
    if (await getCommunityAccount(ctx.db, consumed.userId)) await finalizeAccount(ctx, consumed.userId);
    return jsonResponse({ ok: true });
  });

  /** The caller's own full community record (includes private fields). */
  router.get('/api/community/profile', async (ctx: Ctx) => {
    const auth = requireSession(ctx);
    const account = await getCommunityAccount(ctx.db, auth.userId);
    if (!account) return jsonResponse({ community: null });
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  /** Step 2 of onboarding, and later profile edits. Everything beyond the name is optional. */
  router.put('/api/community/profile', async (ctx: Ctx) => {
    const { auth, account } = await requireOwnCommunityAccount(ctx);
    const body = await readJson(ctx.req);

    let accountType = account.account_type;
    if (body.accountType !== undefined && account.account_type !== 'staff') {
      const requested = oneOf(body.accountType, 'Account type', ACCOUNT_TYPES);
      if (requested !== account.account_type && account.status !== 'pending') {
        throw badRequest('Contact the ECenter to change your account type.', 'Account type');
      }
      accountType = requested;
    }

    const firstName = requiredString(body.firstName, 'First name', { max: 80 });
    const lastName = requiredString(body.lastName, 'Last name', { max: 80 });
    const bio = optionalString(body.bio, 'Bio', { max: 600 });
    const linkedinUrl = optionalLinkedInUrl(body.linkedinUrl);
    const isStudent = accountType === 'student';
    const major = isStudent ? optionalString(body.major, 'Major', { max: 100 }) : null;
    const graduationYear = isStudent ? optionalGraduationYear(body.graduationYear) : null;
    const roleTitle = !isStudent ? optionalString(body.roleTitle, 'Role', { max: 100 }) : null;
    const company = !isStudent ? optionalString(body.company, 'Company', { max: 120 }) : null;
    const schedulingUrl = accountType === 'mentor' ? optionalSchedulingUrl(body.schedulingUrl) : null;

    await ensureDefaultTags(ctx.db, auth.customerId);
    const interestIds = await tagIdsFor(ctx.db, auth.customerId, body.interests, 'Interests');
    const helpIds = await tagIdsFor(ctx.db, auth.customerId, body.help, 'Help topics');

    const timestamp = nowIso();
    await ctx.db.batch([
      {
        sql: `UPDATE community_profiles SET
                first_name = ?, last_name = ?, bio = ?, linkedin_url = ?, major = ?, graduation_year = ?,
                role_title = ?, company = ?, scheduling_url = ?, updated_at = ?
              WHERE user_id = ?`,
        params: [firstName, lastName, bio, linkedinUrl, major, graduationYear, roleTitle, company, schedulingUrl, timestamp, auth.userId],
      },
      {
        sql: `UPDATE community_accounts SET account_type = ?, updated_at = ? WHERE user_id = ?`,
        params: [accountType, timestamp, auth.userId],
      },
      // Only a community-only login's display name follows the profile; a staff
      // member's CRM name is managed in Settings.
      {
        sql: `UPDATE users SET name = ?, updated_at = ? WHERE id = ? AND role = 'member'`,
        params: [`${firstName} ${lastName}`, timestamp, auth.userId],
      },
      ...replaceTagWrites(auth.userId, auth.customerId, 'interest', interestIds),
      ...replaceTagWrites(auth.userId, auth.customerId, 'help', helpIds),
    ]);
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  /** "Create account" / "Skip for now" on step 2. Activation also needs a verified email. */
  router.post('/api/community/onboarding/complete', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const timestamp = nowIso();
    await ctx.db.run(
      `UPDATE community_accounts SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?), updated_at = ?
        WHERE user_id = ?`,
      [timestamp, timestamp, auth.userId],
    );
    await finalizeAccount(ctx, auth.userId);
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  router.post('/api/community/profile/photo', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const stored = await storeCommunityUpload(ctx, { purpose: 'photo', customerId: auth.customerId, ownerId: auth.userId });
    const previous = await ctx.db.get<{ photo_key: string | null }>(
      `SELECT photo_key FROM community_profiles WHERE user_id = ?`,
      [auth.userId],
    );
    await ctx.db.run(`UPDATE community_profiles SET photo_key = ?, photo_type = ?, updated_at = ? WHERE user_id = ?`, [
      stored.key,
      stored.type,
      nowIso(),
      auth.userId,
    ]);
    if (previous?.photo_key) await deleteObject(ctx.env.DOCS, previous.photo_key).catch(() => undefined);
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  router.delete('/api/community/profile/photo', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const previous = await ctx.db.get<{ photo_key: string | null }>(
      `SELECT photo_key FROM community_profiles WHERE user_id = ?`,
      [auth.userId],
    );
    await ctx.db.run(`UPDATE community_profiles SET photo_key = NULL, photo_type = NULL, updated_at = ? WHERE user_id = ?`, [
      nowIso(),
      auth.userId,
    ]);
    if (previous?.photo_key) await deleteObject(ctx.env.DOCS, previous.photo_key).catch(() => undefined);
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  /** Private resume: visible to its owner and to staff, never to other members. */
  router.post('/api/community/profile/resume', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const stored = await storeCommunityUpload(ctx, { purpose: 'resume', customerId: auth.customerId, ownerId: auth.userId });
    const previous = await ctx.db.get<{ resume_key: string | null }>(
      `SELECT resume_key FROM community_accounts WHERE user_id = ?`,
      [auth.userId],
    );
    const timestamp = nowIso();
    await ctx.db.run(
      `UPDATE community_accounts SET resume_key = ?, resume_name = ?, resume_type = ?, resume_size = ?,
              resume_uploaded_at = ?, updated_at = ? WHERE user_id = ?`,
      [stored.key, stored.fileName, stored.type, stored.size, timestamp, timestamp, auth.userId],
    );
    if (previous?.resume_key) await deleteObject(ctx.env.DOCS, previous.resume_key).catch(() => undefined);
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  router.delete('/api/community/profile/resume', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const previous = await ctx.db.get<{ resume_key: string | null }>(
      `SELECT resume_key FROM community_accounts WHERE user_id = ?`,
      [auth.userId],
    );
    await ctx.db.run(
      `UPDATE community_accounts SET resume_key = NULL, resume_name = NULL, resume_type = NULL, resume_size = NULL,
              resume_uploaded_at = NULL, updated_at = ? WHERE user_id = ?`,
      [nowIso(), auth.userId],
    );
    if (previous?.resume_key) await deleteObject(ctx.env.DOCS, previous.resume_key).catch(() => undefined);
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  /** Members choose whether their resume shows on their public profile (private by default). */
  router.put('/api/community/profile/resume-visibility', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const body = await readJson(ctx.req);
    await ctx.db.run(`UPDATE community_accounts SET resume_public = ?, updated_at = ? WHERE user_id = ?`, [
      body.public === true ? 1 : 0,
      nowIso(),
      auth.userId,
    ]);
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  /** Email notification preferences. Each flag is optional; omitted ones are left unchanged. */
  router.put('/api/community/profile/notifications', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const body = await readJson(ctx.req);
    const sets: string[] = [];
    const params: (string | number)[] = [];
    for (const pref of ['messages', 'mentions', 'announcements'] as const) {
      if (typeof body[pref] === 'boolean') {
        sets.push(`${PREFERENCE_COLUMNS[pref]} = ?`);
        params.push(body[pref] ? 1 : 0);
      }
    }
    if (sets.length) {
      await ctx.db.run(`UPDATE community_accounts SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`, [
        ...params,
        nowIso(),
        auth.userId,
      ]);
    }
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
  });

  /**
   * Unsubscribe from one kind of email via a signed link (no sign-in needed).
   * The emailed link opens a confirmation page that POSTs here; mail
   * providers' one-click unsubscribe (RFC 8058) POSTs here directly. A plain
   * GET changes nothing, so link scanners cannot unsubscribe anyone.
   */
  router.post('/api/community/unsubscribe', async (ctx: Ctx) => {
    let token = ctx.query.get('token') ?? '';
    if (!token) {
      const body = await readJson(ctx.req).catch(() => ({}) as Record<string, unknown>);
      token = typeof body.token === 'string' ? body.token : '';
    }
    const parsed = await readUnsubscribeToken(ctx.config, token);
    if (!parsed) throw badRequest('That unsubscribe link is invalid or has expired.');
    await ctx.db.run(`UPDATE community_accounts SET ${PREFERENCE_COLUMNS[parsed.pref]} = 0, updated_at = ? WHERE user_id = ?`, [
      nowIso(),
      parsed.userId,
    ]);
    return jsonResponse({ ok: true, preference: parsed.pref satisfies PreferenceKind });
  });

  router.get('/api/community/profile/resume', async (ctx: Ctx) => {
    const { auth } = await requireOwnCommunityAccount(ctx);
    const row = await ctx.db.get<{ resume_key: string | null }>(`SELECT resume_key FROM community_accounts WHERE user_id = ?`, [
      auth.userId,
    ]);
    if (!row?.resume_key) throw notFound('You have not uploaded a resume.');
    const token = await signValue({ k: 'resume', u: auth.userId }, ctx.config.tokenSecret, ctx.config.downloadUrlTtlSeconds);
    return jsonResponse({ url: `/api/community/files/resume/${auth.userId}?token=${encodeURIComponent(token)}` });
  });

  /** Changing the sign-in email always requires confirming the new address first. */
  router.post('/api/community/account/email', async (ctx: Ctx) => {
    const auth = requireSession(ctx);
    const body = await readJson(ctx.req);
    const email = normaliseEmail(requiredEmail(body.email, 'New email'));
    const current = requiredString(body.password, 'Current password', { max: 200 });

    const user = await ctx.db.get<{ email: string; password_hash: string; name: string }>(
      `SELECT email, password_hash, name FROM users WHERE id = ?`,
      [auth.userId],
    );
    if (!user || !(await verifyPassword(current, user.password_hash))) {
      throw badRequest('Your current password is incorrect.', 'Current password');
    }
    if (normaliseEmail(user.email) === email) throw badRequest('That is already your email address.', 'New email');
    const clash = await ctx.db.get(`SELECT id FROM users WHERE LOWER(email) = ?`, [email]);
    if (clash) throw conflict('That email address is already used by another account.', 'New email');

    await enforceRateLimit(ctx.db, `email-change:${auth.userId}`, { limit: 5, windowSeconds: 3600 });
    const token = await issueToken(ctx.db, {
      userId: auth.userId,
      customerId: auth.customerId,
      purpose: 'change_email',
      email,
    });
    const sent = await sendMail(
      ctx,
      actionEmail({
        to: email,
        subject: 'Confirm your new email for UNH ECenter',
        greeting: `Hi ${user.name.split(' ')[0]},`,
        intro: 'Confirm this address to make it the new sign-in email on your UNH ECenter account.',
        actionLabel: 'Confirm new email',
        url: `${appBaseUrl(ctx)}/verify-email?type=change&token=${encodeURIComponent(token)}`,
        outro: 'Your current email keeps working until you confirm. This link expires in 24 hours.',
      }),
    );
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'community.email_change_requested',
      entityType: 'user',
      entityId: auth.userId,
      req: ctx.req,
    });
    return jsonResponse({ ok: sent, verificationEmailSent: sent });
  });

  /**
   * Staff join the community through an explicit identity, so they can message
   * members. It is labelled "ECenter staff", is never linked to a CRM contact,
   * and grants nothing administrative (and takes nothing away).
   */
  router.post('/api/community/staff-identity', async (ctx: Ctx) => {
    const auth = requireStaff(ctx);
    const existing = await getCommunityAccount(ctx.db, auth.userId);
    if (existing) {
      if (existing.status === 'deactivated') throw forbidden('Your community identity has been deactivated.');
      return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) });
    }
    const [first, ...rest] = auth.name.trim().split(/\s+/);
    const timestamp = nowIso();
    await ctx.db.batch([
      {
        sql: `INSERT OR IGNORE INTO community_accounts
                (user_id, customer_id, account_type, status, onboarding_completed_at, activated_at,
                 link_state, created_at, updated_at)
              VALUES (?, ?, 'staff', 'active', ?, ?, 'not_applicable', ?, ?)`,
        params: [auth.userId, auth.customerId, timestamp, timestamp, timestamp, timestamp],
      },
      {
        sql: `INSERT OR IGNORE INTO community_profiles (user_id, customer_id, first_name, last_name, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
        params: [auth.userId, auth.customerId, first || auth.name, rest.join(' ') || '', timestamp],
      },
    ]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'community.staff_identity_created',
      entityType: 'user',
      entityId: auth.userId,
      req: ctx.req,
    });
    return jsonResponse({ community: await ownCommunityState(ctx, auth.userId) }, { status: 201 });
  });
}

