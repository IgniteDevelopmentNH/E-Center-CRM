import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, forbidden, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, optionalString, positiveInt, requiredString } from '../lib/validate.ts';
import {
  requireActiveCommunityMember,
  requireCommunityViewer,
  requireEditor,
  requireSession,
  requireStaff,
} from '../middleware/auth.ts';
import type { AuthContext, Ctx, Router } from '../router.ts';
import { photoUrl } from '../services/community.ts';
import {
  canCreateGroups,
  canModerate,
  canReadGroup,
  ensureDefaultGroups,
  isStaffModerator,
  loadGroup,
  membershipOf,
  requireGroupModerator,
  uniqueGroupSlug,
} from '../services/groups.ts';
import type { GroupRow, Membership } from '../services/groups.ts';
import { POST_SELECT, communityPostOut, viewerParams } from '../services/posts.ts';

/**
 * Community groups (see services/groups.ts for the rules). Members browse,
 * join and leave; moderators edit their group, make it private, approve join
 * requests and manage members; staff owners/editors moderate every group.
 */

const PRIVACY = ['public', 'private'] as const;

const GROUP_SELECT = `
  SELECT g.*,
         (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count,
         (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'pending') AS pending_count,
         (SELECT COUNT(*) FROM post_groups pg JOIN posts p ON p.id = pg.post_id
           WHERE pg.group_id = g.id AND p.status = 'published' AND p.deleted_at IS NULL) AS post_count,
         me.role AS my_role, me.status AS my_status
    FROM community_groups g
    LEFT JOIN group_members me ON me.group_id = g.id AND me.user_id = ?`;

function groupOut(row: Record<string, unknown>, auth: AuthContext) {
  const membership: Membership | null = row.my_status
    ? { role: String(row.my_role) as Membership['role'], status: String(row.my_status) as Membership['status'] }
    : null;
  const moderates = canModerate(auth, membership);
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    privacy: String(row.privacy) as 'public' | 'private',
    isDefault: Number(row.is_default) === 1,
    archived: !!row.archived_at,
    memberCount: Number(row.member_count ?? 0),
    postCount: Number(row.post_count ?? 0),
    // Join requests waiting: shown to moderators only.
    pendingCount: moderates ? Number(row.pending_count ?? 0) : 0,
    membership: membership ? { role: membership.role, status: membership.status } : null,
    canModerate: moderates,
    canRead: String(row.privacy) === 'public' || membership?.status === 'active' || isStaffModerator(auth),
  };
}

async function loadGroupFor(ctx: Ctx, auth: AuthContext, idOrSlug: string, includeArchived = false) {
  const row = await ctx.db.get<Record<string, unknown>>(
    `${GROUP_SELECT} WHERE g.customer_id = ? AND (g.id = ? OR g.slug = ?) ${includeArchived ? '' : 'AND g.archived_at IS NULL'}`,
    [auth.userId, auth.customerId, idOrSlug, idOrSlug],
  );
  if (!row) throw notFound('That group is not available.');
  return row;
}

async function membersOf(ctx: Ctx, groupId: string, status: 'active' | 'pending') {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT gm.user_id, gm.role, gm.status, gm.requested_at, gm.joined_at,
            p.first_name, p.last_name, p.photo_key, ca.account_type
       FROM group_members gm
       JOIN community_accounts ca ON ca.user_id = gm.user_id AND ca.status = 'active'
       JOIN community_profiles p ON p.user_id = gm.user_id
      WHERE gm.group_id = ? AND gm.status = ?
      ORDER BY CASE gm.role WHEN 'moderator' THEN 0 ELSE 1 END, p.first_name ASC, p.last_name ASC
      LIMIT 1000`,
    [groupId, status],
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: String(row.user_id),
      name: `${String(row.first_name)} ${String(row.last_name ?? '')}`.trim(),
      accountType: String(row.account_type),
      photoUrl: await photoUrl(ctx, String(row.user_id), row.photo_key),
      role: String(row.role) as 'member' | 'moderator',
      requestedAt: String(row.requested_at),
      joinedAt: row.joined_at ? String(row.joined_at) : null,
    })),
  );
}

function parseGroupFields(body: Record<string, unknown>) {
  return {
    name: requiredString(body.name, 'Group name', { max: 80 }),
    description: optionalString(body.description, 'Description', { max: 1000 }),
    privacy: oneOf(body.privacy, 'Privacy', PRIVACY, 'public'),
  };
}

/** Adds (or promotes) a member. Moderators are always active members. */
async function upsertMember(ctx: Ctx, group: GroupRow, userId: string, role: 'member' | 'moderator') {
  const timestamp = nowIso();
  await ctx.db.run(
    `INSERT INTO group_members (group_id, user_id, customer_id, role, status, requested_at, joined_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (group_id, user_id) DO UPDATE SET role = excluded.role, status = 'active',
       joined_at = COALESCE(group_members.joined_at, excluded.joined_at)`,
    [group.id, userId, group.customer_id, role, timestamp, timestamp],
  );
}

async function requireActiveMemberAccount(ctx: Ctx, customerId: string, userId: string) {
  const account = await ctx.db.get<{ status: string }>(
    `SELECT status FROM community_accounts WHERE user_id = ? AND customer_id = ?`,
    [userId, customerId],
  );
  if (!account || account.status !== 'active') throw badRequest('That person does not have an active community account.');
}

export function register(router: Router): void {
  /* ------------------------------------------------------- browse -- */

  router.get('/api/community/groups', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    await ensureDefaultGroups(ctx.db, auth.customerId);
    const where = ['g.customer_id = ?', 'g.archived_at IS NULL'];
    const params: SqlParam[] = [auth.customerId];
    if (ctx.query.get('mine') === '1') {
      where.push(`me.status = 'active'`);
    }
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${GROUP_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY CASE WHEN me.status = 'active' THEN 0 ELSE 1 END, g.is_default DESC, g.name ASC`,
      [auth.userId, ...params],
    );
    return jsonResponse({
      groups: rows.map((row) => groupOut(row, auth)),
      canCreate: await canCreateGroups(ctx.db, auth),
    });
  });

  router.get('/api/community/groups/:id', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const row = await loadGroupFor(ctx, auth, ctx.params.id!);
    const group = groupOut(row, auth);
    // Moderators are listed even on private groups, so people know whom to ask.
    const moderators = (await membersOf(ctx, group.id, 'active')).filter((m) => m.role === 'moderator');
    return jsonResponse({ group, moderators });
  });

  router.get('/api/community/groups/:id/posts', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const group = await loadGroup(ctx.db, auth.customerId, ctx.params.id!);
    const membership = await membershipOf(ctx.db, group.id, auth.userId);
    if (!canReadGroup(auth, group, membership)) throw forbidden('This group is private. Ask to join to see its posts.');
    const limit = positiveInt(ctx.query.get('limit'), 10, 30);
    const where = [
      'p.customer_id = ?',
      `p.status = 'published'`,
      'p.deleted_at IS NULL',
      'p.published_at IS NOT NULL',
      'EXISTS (SELECT 1 FROM post_groups pg WHERE pg.post_id = p.id AND pg.group_id = ?)',
    ];
    const params: SqlParam[] = [auth.customerId, group.id];
    const cursor = ctx.query.get('cursor');
    if (cursor) {
      const [publishedAt, id] = cursor.split('|');
      if (!publishedAt || !id) throw badRequest('Invalid cursor.');
      where.push('(p.published_at < ? OR (p.published_at = ? AND p.id < ?))');
      params.push(publishedAt, publishedAt, id);
    }
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${POST_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.published_at DESC, p.id DESC LIMIT ?`,
      [...viewerParams(auth), ...params, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return jsonResponse({
      posts: await Promise.all(page.map((row) => communityPostOut(ctx, row, auth))),
      nextCursor: rows.length > limit && last ? `${String(last.published_at)}|${String(last.id)}` : null,
    });
  });

  router.get('/api/community/groups/:id/members', async (ctx: Ctx) => {
    const { auth } = await requireCommunityViewer(ctx);
    const group = await loadGroup(ctx.db, auth.customerId, ctx.params.id!);
    const membership = await membershipOf(ctx.db, group.id, auth.userId);
    if (!canReadGroup(auth, group, membership)) throw forbidden('This group is private. Ask to join to see its members.');
    const moderates = canModerate(auth, membership);
    return jsonResponse({
      members: await membersOf(ctx, group.id, 'active'),
      requests: moderates ? await membersOf(ctx, group.id, 'pending') : [],
    });
  });

  /* --------------------------------------------- join and leave -- */

  router.post('/api/community/groups/:id/join', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const group = await loadGroup(ctx.db, auth.customerId, ctx.params.id!);
    const existing = await membershipOf(ctx.db, group.id, auth.userId);
    if (!existing) {
      const timestamp = nowIso();
      // Public groups: join instantly. Private: a request a moderator approves.
      const status = group.privacy === 'public' || isStaffModerator(auth) ? 'active' : 'pending';
      await ctx.db.run(
        `INSERT OR IGNORE INTO group_members (group_id, user_id, customer_id, role, status, requested_at, joined_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?)`,
        [group.id, auth.userId, auth.customerId, status, timestamp, status === 'active' ? timestamp : null],
      );
    }
    return jsonResponse({ group: groupOut(await loadGroupFor(ctx, auth, group.id), auth) });
  });

  /** Leave a group, or withdraw a join request. */
  router.post('/api/community/groups/:id/leave', async (ctx: Ctx) => {
    const { auth } = await requireActiveCommunityMember(ctx);
    const group = await loadGroup(ctx.db, auth.customerId, ctx.params.id!);
    await ctx.db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, [group.id, auth.userId]);
    return jsonResponse({ group: groupOut(await loadGroupFor(ctx, auth, group.id), auth) });
  });

  /* ------------------------------------------------- moderation -- */

  router.post('/api/community/groups', async (ctx: Ctx) => {
    const auth = requireSession(ctx);
    if (!(await canCreateGroups(ctx.db, auth))) {
      throw forbidden('Your account cannot create groups. Ask the ECenter if you would like to start one.');
    }
    // Members who create a group become its moderator. Staff moderate every group anyway, and are
    // listed as its moderator only if they have a community identity.
    const creatorAccount = await ctx.db.get<{ status: string }>(`SELECT status FROM community_accounts WHERE user_id = ?`, [auth.userId]);
    if (!isStaffModerator(auth)) await requireActiveCommunityMember(ctx);
    const addCreator = creatorAccount?.status === 'active';
    const fields = parseGroupFields(await readJson(ctx.req));
    const clash = await ctx.db.get(
      `SELECT 1 AS taken FROM community_groups WHERE customer_id = ? AND LOWER(name) = LOWER(?) AND archived_at IS NULL`,
      [auth.customerId, fields.name],
    );
    if (clash) throw conflict('A group with that name already exists.', 'Group name');
    const id = newId();
    const timestamp = nowIso();
    const slug = await uniqueGroupSlug(ctx.db, auth.customerId, fields.name);
    await ctx.db.batch([
      {
        sql: `INSERT INTO community_groups (id, customer_id, slug, name, description, privacy, is_default, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        params: [id, auth.customerId, slug, fields.name, fields.description, fields.privacy, auth.userId, timestamp, timestamp],
      },
      ...(addCreator
        ? [
            {
              sql: `INSERT INTO group_members (group_id, user_id, customer_id, role, status, requested_at, joined_at)
                    VALUES (?, ?, ?, 'moderator', 'active', ?, ?)`,
              params: [id, auth.userId, auth.customerId, timestamp, timestamp] as SqlParam[],
            },
          ]
        : []),
    ]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'group.create',
      entityType: 'group',
      entityId: id,
      metadata: { name: fields.name, privacy: fields.privacy },
      req: ctx.req,
    });
    return jsonResponse({ group: groupOut(await loadGroupFor(ctx, auth, id), auth) }, { status: 201 });
  });

  /** Moderators edit the group. Making it public lets everyone waiting in. */
  router.put('/api/community/groups/:id', async (ctx: Ctx) => {
    const auth = (await requireCommunityViewer(ctx)).auth;
    const { group } = await requireGroupModerator(ctx.db, auth, ctx.params.id!);
    const fields = parseGroupFields(await readJson(ctx.req));
    const clash = await ctx.db.get(
      `SELECT 1 AS taken FROM community_groups
        WHERE customer_id = ? AND LOWER(name) = LOWER(?) AND archived_at IS NULL AND id <> ?`,
      [auth.customerId, fields.name, group.id],
    );
    if (clash) throw conflict('A group with that name already exists.', 'Group name');
    const timestamp = nowIso();
    await ctx.db.batch([
      {
        sql: `UPDATE community_groups SET name = ?, description = ?, privacy = ?, updated_at = ? WHERE id = ?`,
        params: [fields.name, fields.description, fields.privacy, timestamp, group.id],
      },
      ...(fields.privacy === 'public'
        ? [
            {
              sql: `UPDATE group_members SET status = 'active', joined_at = ? WHERE group_id = ? AND status = 'pending'`,
              params: [timestamp, group.id] as SqlParam[],
            },
          ]
        : []),
    ]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'group.update',
      entityType: 'group',
      entityId: group.id,
      metadata: { name: fields.name, privacy: fields.privacy, previousPrivacy: group.privacy },
      req: ctx.req,
    });
    return jsonResponse({ group: groupOut(await loadGroupFor(ctx, auth, group.id), auth) });
  });

  router.post('/api/community/groups/:id/requests/:userId/approve', async (ctx: Ctx) => {
    const auth = (await requireCommunityViewer(ctx)).auth;
    const { group } = await requireGroupModerator(ctx.db, auth, ctx.params.id!);
    const request = await membershipOf(ctx.db, group.id, ctx.params.userId!);
    if (request?.status !== 'pending') throw notFound('That request is no longer waiting.');
    await ctx.db.run(`UPDATE group_members SET status = 'active', joined_at = ? WHERE group_id = ? AND user_id = ?`, [
      nowIso(),
      group.id,
      ctx.params.userId!,
    ]);
    return jsonResponse({ members: await membersOf(ctx, group.id, 'active'), requests: await membersOf(ctx, group.id, 'pending') });
  });

  router.post('/api/community/groups/:id/requests/:userId/deny', async (ctx: Ctx) => {
    const auth = (await requireCommunityViewer(ctx)).auth;
    const { group } = await requireGroupModerator(ctx.db, auth, ctx.params.id!);
    await ctx.db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'pending'`, [
      group.id,
      ctx.params.userId!,
    ]);
    return jsonResponse({ members: await membersOf(ctx, group.id, 'active'), requests: await membersOf(ctx, group.id, 'pending') });
  });

  router.delete('/api/community/groups/:id/members/:userId', async (ctx: Ctx) => {
    const auth = (await requireCommunityViewer(ctx)).auth;
    const { group } = await requireGroupModerator(ctx.db, auth, ctx.params.id!);
    if (ctx.params.userId === auth.userId) throw badRequest('Use "Leave group" to leave it yourself.');
    await ctx.db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, [group.id, ctx.params.userId!]);
    return jsonResponse({ members: await membersOf(ctx, group.id, 'active'), requests: await membersOf(ctx, group.id, 'pending') });
  });

  /** Make someone a moderator (adding them if needed), or back to a regular member. */
  router.put('/api/community/groups/:id/members/:userId/role', async (ctx: Ctx) => {
    const auth = (await requireCommunityViewer(ctx)).auth;
    const { group } = await requireGroupModerator(ctx.db, auth, ctx.params.id!);
    const role = oneOf((await readJson(ctx.req)).role, 'Role', ['member', 'moderator'] as const);
    await requireActiveMemberAccount(ctx, auth.customerId, ctx.params.userId!);
    if (role === 'member') {
      const moderators = await ctx.db.get<{ total: unknown }>(
        `SELECT COUNT(*) AS total FROM group_members WHERE group_id = ? AND role = 'moderator' AND status = 'active' AND user_id <> ?`,
        [group.id, ctx.params.userId!],
      );
      if (Number(moderators?.total ?? 0) === 0 && !isStaffModerator(auth)) {
        throw badRequest('A group needs at least one moderator. Make someone else a moderator first.');
      }
    }
    await upsertMember(ctx, group, ctx.params.userId!, role);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'group.moderators',
      entityType: 'group',
      entityId: group.id,
      metadata: { userId: ctx.params.userId!, role },
      req: ctx.req,
    });
    return jsonResponse({ members: await membersOf(ctx, group.id, 'active'), requests: await membersOf(ctx, group.id, 'pending') });
  });

  /** Archive a group: staff, or the group's own moderators for groups they created. Default groups need staff. */
  router.delete('/api/community/groups/:id', async (ctx: Ctx) => {
    const auth = (await requireCommunityViewer(ctx)).auth;
    const { group } = await requireGroupModerator(ctx.db, auth, ctx.params.id!);
    if (Number(group.is_default) === 1 && !isStaffModerator(auth)) {
      throw forbidden('Only ECenter staff can archive a default group.');
    }
    await ctx.db.run(`UPDATE community_groups SET archived_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), group.id]);
    await audit(ctx.db, {
      customerId: auth.customerId,
      userId: auth.userId,
      action: 'group.archive',
      entityType: 'group',
      entityId: group.id,
      metadata: { name: group.name },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });

  /* ------------------------------------------------------ admin -- */

  /** Admin > Groups: every group, archived ones too. */
  router.get('/api/admin/groups', async (ctx: Ctx) => {
    const auth = requireStaff(ctx);
    await ensureDefaultGroups(ctx.db, auth.customerId);
    const rows = await ctx.db.all<Record<string, unknown>>(
      `${GROUP_SELECT} WHERE g.customer_id = ?
        ORDER BY CASE WHEN g.archived_at IS NULL THEN 0 ELSE 1 END, g.is_default DESC, g.name ASC`,
      [auth.userId, auth.customerId],
    );
    const moderators = await ctx.db.all<{ group_id: string; user_id: string; first_name: string; last_name: string }>(
      `SELECT gm.group_id, gm.user_id, p.first_name, p.last_name
         FROM group_members gm JOIN community_profiles p ON p.user_id = gm.user_id
        WHERE gm.customer_id = ? AND gm.role = 'moderator' AND gm.status = 'active'`,
      [auth.customerId],
    );
    return jsonResponse({
      groups: rows.map((row) => ({
        ...groupOut(row, auth),
        moderators: moderators
          .filter((m) => m.group_id === String(row.id))
          .map((m) => ({ id: m.user_id, name: `${m.first_name} ${m.last_name ?? ''}`.trim() })),
      })),
    });
  });

  router.post('/api/admin/groups/:id/restore', async (ctx: Ctx) => {
    const auth = requireEditor(ctx);
    const row = await loadGroupFor(ctx, auth, ctx.params.id!, true);
    await ctx.db.run(`UPDATE community_groups SET archived_at = NULL, updated_at = ? WHERE id = ?`, [nowIso(), String(row.id)]);
    return jsonResponse({ group: groupOut(await loadGroupFor(ctx, auth, String(row.id)), auth) });
  });
}
