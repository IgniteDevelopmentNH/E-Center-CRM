import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { revokeAllSessionsForUser } from '../lib/session.ts';
import { signValue } from '../lib/signedToken.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, optionalId, optionalString, positiveInt } from '../lib/validate.ts';
import { requireEditor, requireStaff } from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';
import { finalizeAccount, loadTags, staffLinkAccount } from '../services/community.ts';
import { POST_PERMISSIONS, effectivePostPermission } from '../services/posts.ts';

/**
 * Staff view of community accounts. Owners and editors can deactivate,
 * reactivate and resolve CRM link conflicts; viewers can look. "Remove from
 * the community" means DEACTIVATE: access is revoked and the member leaves
 * discovery, but the CRM contact, notes, relationships and conversation
 * history are all kept. Nothing here deletes anything.
 *
 * Staff can see account state and the private resume, but NOT anyone's
 * private messages -- there is no route for that.
 */

const STATUSES = ['pending', 'active', 'deactivated'] as const;
const TYPES = ['student', 'mentor', 'staff'] as const;
const LINK_STATES = ['pending', 'linked', 'conflict', 'unlinked', 'not_applicable'] as const;

const SELECT_ACCOUNT = `
  SELECT ca.*, u.email, u.email_verified_at, u.role AS user_role, u.last_login_at,
         p.first_name, p.last_name, p.bio, p.role_title, p.company, p.major, p.graduation_year,
         p.linkedin_url, p.scheduling_url,
         c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.email AS contact_email,
         deactivator.name AS deactivated_by_name
    FROM community_accounts ca
    JOIN users u ON u.id = ca.user_id
    JOIN community_profiles p ON p.user_id = ca.user_id
    LEFT JOIN contacts c ON c.id = ca.contact_id AND c.deleted_at IS NULL
    LEFT JOIN users deactivator ON deactivator.id = ca.deactivated_by`;

function accountOut(row: Record<string, unknown>) {
  return {
    userId: String(row.user_id),
    fullName: `${String(row.first_name)} ${String(row.last_name)}`.trim(),
    email: String(row.email),
    emailVerified: !!row.email_verified_at,
    accountType: String(row.account_type),
    status: String(row.status),
    onboardingCompleted: !!row.onboarding_completed_at,
    linkState: String(row.link_state),
    contactId: row.contact_first_name ? String(row.contact_id) : null,
    contactName: row.contact_first_name ? `${String(row.contact_first_name)} ${String(row.contact_last_name)}` : null,
    contactEmail: row.contact_email ? String(row.contact_email) : null,
    // The account's sign-in email can differ from the contact's (staff-owned) email
    // after an email change; it is shown, never silently "fixed" in either direction.
    emailDiffersFromContact:
      !!row.contact_email && String(row.contact_email).trim().toLowerCase() !== String(row.email).trim().toLowerCase(),
    hasResume: !!row.resume_key,
    resumePublic: Number(row.resume_public ?? 0) === 1,
    // Stored override (null = account-type default) and what actually applies.
    postPermissionOverride: row.post_permission ? String(row.post_permission) : null,
    postPermission: effectivePostPermission(String(row.account_type), row.post_permission as string | null, String(row.user_role)),
    resumeName: row.resume_name ? String(row.resume_name) : null,
    createdAt: String(row.created_at),
    activatedAt: row.activated_at ? String(row.activated_at) : null,
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    deactivatedAt: row.deactivated_at ? String(row.deactivated_at) : null,
    deactivatedByName: row.deactivated_by_name ? String(row.deactivated_by_name) : null,
    deactivationReason: row.deactivation_reason ? String(row.deactivation_reason) : null,
    profile: {
      bio: row.bio ? String(row.bio) : null,
      roleTitle: row.role_title ? String(row.role_title) : null,
      company: row.company ? String(row.company) : null,
      major: row.major ? String(row.major) : null,
      graduationYear: row.graduation_year ? Number(row.graduation_year) : null,
      linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : null,
      schedulingUrl: row.scheduling_url ? String(row.scheduling_url) : null,
    },
  };
}

async function loadAccount(ctx: Ctx, userId: string, customerId: string) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `${SELECT_ACCOUNT} WHERE ca.user_id = ? AND ca.customer_id = ?`,
    [userId, customerId],
  );
  if (!row) throw notFound('That community account was not found.');
  return row;
}

async function detail(ctx: Ctx, userId: string, customerId: string) {
  const row = await loadAccount(ctx, userId, customerId);
  let candidates: unknown[] = [];
  if (row.link_state === 'conflict' && row.link_candidates) {
    let ids: string[] = [];
    try {
      ids = (JSON.parse(String(row.link_candidates)) as unknown[]).filter((v): v is string => typeof v === 'string');
    } catch {
      ids = [];
    }
    if (ids.length) {
      const rows = await ctx.db.all<Record<string, unknown>>(
        `SELECT c.id, c.first_name, c.last_name, c.email, c.status, o.name AS organization_name, c.created_at,
                ca.user_id AS linked_user
           FROM contacts c
           LEFT JOIN organizations o ON o.id = c.organization_id
           LEFT JOIN community_accounts ca ON ca.contact_id = c.id
          WHERE c.customer_id = ? AND c.deleted_at IS NULL AND c.id IN (${ids.map(() => '?').join(', ')})
          ORDER BY c.created_at ASC`,
        [customerId, ...ids],
      );
      candidates = rows.map((c) => ({
        id: String(c.id),
        fullName: `${String(c.first_name)} ${String(c.last_name)}`,
        email: String(c.email),
        status: String(c.status),
        organizationName: c.organization_name ? String(c.organization_name) : null,
        createdAt: String(c.created_at),
        linkedToAnotherAccount: !!c.linked_user && String(c.linked_user) !== userId,
      }));
    }
  }
  const tags = (await loadTags(ctx.db, [userId])).get(userId);
  return { account: { ...accountOut(row), interests: tags?.interests ?? [], help: tags?.help ?? [] }, candidates };
}

export function register(router: Router): void {
  router.get('/api/admin/community/accounts', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    const where = ['ca.customer_id = ?'];
    const params: SqlParam[] = [customerId];
    const status = ctx.query.get('status');
    if (status && status !== 'all') {
      where.push('ca.status = ?');
      params.push(oneOf(status, 'Status', STATUSES));
    }
    const type = ctx.query.get('type');
    if (type && type !== 'all') {
      where.push('ca.account_type = ?');
      params.push(oneOf(type, 'Type', TYPES));
    }
    const link = ctx.query.get('link');
    if (link && link !== 'all') {
      where.push('ca.link_state = ?');
      params.push(oneOf(link, 'Link', LINK_STATES));
    }
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    if (q) {
      const like = `%${q}%`;
      where.push(`(LOWER(p.first_name || ' ' || p.last_name) LIKE ? OR LOWER(u.email) LIKE ?)`);
      params.push(like, like);
    }
    const limit = positiveInt(ctx.query.get('limit'), 25, 100);
    const page = positiveInt(ctx.query.get('page'), 1, 1000);
    const total = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM community_accounts ca
         JOIN users u ON u.id = ca.user_id JOIN community_profiles p ON p.user_id = ca.user_id
        WHERE ${where.join(' AND ')}`,
      params,
    );
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${SELECT_ACCOUNT} WHERE ${where.join(' AND ')}
        ORDER BY CASE ca.link_state WHEN 'conflict' THEN 0 ELSE 1 END, ca.created_at DESC, ca.user_id ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const counts = await ctx.db.all<{ status: string; link_state: string; total: unknown }>(
      `SELECT status, link_state, COUNT(*) AS total FROM community_accounts WHERE customer_id = ? GROUP BY status, link_state`,
      [customerId],
    );
    const summary = { pending: 0, active: 0, deactivated: 0, conflicts: 0 };
    for (const c of counts) {
      const n = Number(c.total);
      if (c.status in summary) summary[c.status as 'pending' | 'active' | 'deactivated'] += n;
      if (c.link_state === 'conflict') summary.conflicts += n;
    }
    return jsonResponse({
      accounts: rows.map(accountOut),
      page,
      limit,
      total: Number(total?.total ?? 0),
      summary,
    });
  });

  router.get('/api/admin/community/accounts/:userId', async (ctx: Ctx) => {
    const { customerId } = requireStaff(ctx);
    return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
  });

  router.post('/api/admin/community/accounts/:userId/deactivate', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const row = await loadAccount(ctx, ctx.params.userId!, customerId);
    if (row.status === 'deactivated') return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
    const body = await readJson(ctx.req);
    const reason = optionalString(body.reason, 'Reason', { max: 500 });
    const timestamp = nowIso();
    await ctx.db.run(
      `UPDATE community_accounts SET status = 'deactivated', deactivated_at = ?, deactivated_by = ?,
              deactivation_reason = ?, updated_at = ?
        WHERE user_id = ? AND customer_id = ?`,
      [timestamp, userId, reason, timestamp, ctx.params.userId!, customerId],
    );
    // A community-only login is signed out everywhere now. A staff member's
    // community identity is deactivated without touching their CRM sessions.
    if (row.user_role === 'member') await revokeAllSessionsForUser(ctx.db, ctx.params.userId!);
    await audit(ctx.db, {
      customerId,
      userId,
      action: 'community.deactivated',
      entityType: 'user',
      entityId: ctx.params.userId!,
      metadata: { name: `${String(row.first_name)} ${String(row.last_name)}`, reason, previousStatus: String(row.status) },
      req: ctx.req,
    });
    return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
  });

  router.post('/api/admin/community/accounts/:userId/reactivate', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const row = await loadAccount(ctx, ctx.params.userId!, customerId);
    if (row.status !== 'deactivated') return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
    const ready = !!row.onboarding_completed_at && (!!row.email_verified_at || row.account_type === 'staff');
    const timestamp = nowIso();
    await ctx.db.run(
      `UPDATE community_accounts SET status = ?, deactivated_at = NULL, deactivated_by = NULL,
              deactivation_reason = NULL, updated_at = ?
        WHERE user_id = ? AND customer_id = ?`,
      [ready ? 'active' : 'pending', timestamp, ctx.params.userId!, customerId],
    );
    await audit(ctx.db, {
      customerId,
      userId,
      action: 'community.reactivated',
      entityType: 'user',
      entityId: ctx.params.userId!,
      metadata: { name: `${String(row.first_name)} ${String(row.last_name)}` },
      req: ctx.req,
    });
    await finalizeAccount(ctx, ctx.params.userId!);
    return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
  });

  /** Resolve a conflict: link to the chosen existing contact, or (contactId null) create a new one. */
  router.post('/api/admin/community/accounts/:userId/link', async (ctx: Ctx) => {
    const { customerId } = requireEditor(ctx);
    const row = await loadAccount(ctx, ctx.params.userId!, customerId);
    if (row.account_type === 'staff') throw badRequest('Staff community identities are not linked to contacts.');
    if (!row.email_verified_at) throw badRequest('The member has not verified their email yet.');
    const body = await readJson(ctx.req);
    const contactId = body.createNew === true ? null : optionalId(body.contactId, 'Contact');
    if (!contactId && body.createNew !== true) throw badRequest('Choose a contact, or create a new one.', 'Contact');

    const result = await staffLinkAccount(ctx, { userId: ctx.params.userId!, customerId, contactId });
    if (result === 'not_found') throw notFound('That contact was not found.');
    if (result === 'contact_taken') throw conflict('That contact is already linked to another community account.');
    return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
  });

  /** Re-runs automatic matching (after staff fixed duplicate contacts, for example). */
  router.post('/api/admin/community/accounts/:userId/retry-link', async (ctx: Ctx) => {
    const { customerId } = requireEditor(ctx);
    const row = await loadAccount(ctx, ctx.params.userId!, customerId);
    if (row.account_type === 'staff') throw badRequest('Staff community identities are not linked to contacts.');
    await ctx.db.run(
      `UPDATE community_accounts SET link_state = 'pending', link_candidates = NULL, updated_at = ?
        WHERE user_id = ? AND customer_id = ? AND contact_id IS NULL AND link_state IN ('pending', 'conflict', 'unlinked')`,
      [nowIso(), ctx.params.userId!, customerId],
    );
    await finalizeAccount(ctx, ctx.params.userId!);
    return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
  });

  /**
   * Posting permission for one member: 'none' | 'approval' | 'direct', or
   * 'default' to go back to the account-type default (students none,
   * mentors approval). Owners and editors only.
   */
  router.put('/api/admin/community/accounts/:userId/permissions', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const row = await loadAccount(ctx, ctx.params.userId!, customerId);
    const body = await readJson(ctx.req);
    const value = oneOf(body.postPermission, 'Posting', [...POST_PERMISSIONS, 'default'] as const);
    await ctx.db.run(`UPDATE community_accounts SET post_permission = ?, updated_at = ? WHERE user_id = ? AND customer_id = ?`, [
      value === 'default' ? null : value,
      nowIso(),
      ctx.params.userId!,
      customerId,
    ]);
    await audit(ctx.db, {
      customerId,
      userId,
      action: 'community.permissions_changed',
      entityType: 'user',
      entityId: ctx.params.userId!,
      metadata: {
        name: `${String(row.first_name)} ${String(row.last_name)}`,
        from: row.post_permission ?? 'default',
        to: value,
      },
      req: ctx.req,
    });
    return jsonResponse(await detail(ctx, ctx.params.userId!, customerId));
  });

  /** Short-lived link to a member's private resume. The download itself is audited. */
  router.get('/api/admin/community/accounts/:userId/resume', async (ctx: Ctx) => {
    const { customerId, userId } = requireStaff(ctx);
    const row = await loadAccount(ctx, ctx.params.userId!, customerId);
    if (!row.resume_key) throw notFound('No resume uploaded.');
    const token = await signValue(
      { k: 'resume', u: ctx.params.userId!, by: userId },
      ctx.config.tokenSecret,
      ctx.config.downloadUrlTtlSeconds,
    );
    return jsonResponse({ url: `/api/community/files/resume/${ctx.params.userId!}?token=${encodeURIComponent(token)}` });
  });
}
