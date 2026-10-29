import type { Db, SqlParam } from '../db/driver.ts';
import { badRequest, forbidden, notFound } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { isStaffRole } from '../middleware/auth.ts';
import type { AuthContext } from '../router.ts';
import { slugify } from './community.ts';

/**
 * Community groups.
 *
 *   Public group   anyone in the community can read it and join instantly.
 *   Private group  name and description are listed, but posts and members
 *                  are visible only to members; joining sends a request a
 *                  moderator approves or declines.
 *
 * Who manages a group: its moderators (group_members.role = 'moderator'), and
 * any staff owner/editor. Who may create one: staff, plus members that staff
 * have given "Can create groups" (community_accounts.group_permission). The
 * creator becomes its first moderator.
 *
 * Group-only posts (posts.audience = 'groups') are linked through post_groups
 * and appear only in those groups' feeds -- never in the main feed.
 */

export const DEFAULT_GROUPS: { name: string; description: string }[] = [
  { name: 'Entrepreneurship', description: 'Starting and growing ventures: ideas, validation, founders and lessons learned.' },
  { name: 'Finance', description: 'Financial planning, modeling, pricing and managing a startup’s money.' },
  { name: 'Accounting', description: 'Bookkeeping, taxes, financial statements and staying compliant.' },
  { name: 'Marketing', description: 'Branding, positioning, social media, content and growth.' },
  { name: 'Sales', description: 'Finding customers, pitching, partnerships and closing deals.' },
  { name: 'Technology', description: 'Building products with software, data and emerging tech.' },
  { name: 'Fundraising', description: 'Grants, competitions, angels and venture capital.' },
  { name: 'Social Impact', description: 'Mission-driven ventures, nonprofits and sustainability.' },
];

export async function ensureDefaultGroups(db: Db, customerId: string): Promise<void> {
  const existing = await db.get<{ total: unknown }>(
    `SELECT COUNT(*) AS total FROM community_groups WHERE customer_id = ? AND is_default = 1`,
    [customerId],
  );
  if (Number(existing?.total ?? 0) > 0) return;
  const timestamp = nowIso();
  await db.batch(
    DEFAULT_GROUPS.map((group) => ({
      sql: `INSERT OR IGNORE INTO community_groups
              (id, customer_id, slug, name, description, privacy, is_default, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'public', 1, ?, ?)`,
      params: [newId(), customerId, slugify(group.name), group.name, group.description, timestamp, timestamp],
    })),
  );
}

export function isStaffModerator(auth: AuthContext): boolean {
  return isStaffRole(auth.role) && (auth.role === 'owner' || auth.role === 'editor');
}

export interface GroupRow {
  id: string;
  customer_id: string;
  slug: string;
  name: string;
  description: string | null;
  privacy: 'public' | 'private';
  is_default: number;
  created_by: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface Membership {
  role: 'member' | 'moderator';
  status: 'active' | 'pending';
}

export async function loadGroup(db: Db, customerId: string, idOrSlug: string): Promise<GroupRow> {
  const group = await db.get<GroupRow>(
    `SELECT * FROM community_groups WHERE customer_id = ? AND (id = ? OR slug = ?) AND archived_at IS NULL`,
    [customerId, idOrSlug, idOrSlug],
  );
  if (!group) throw notFound('That group is not available.');
  return group;
}

export async function membershipOf(db: Db, groupId: string, userId: string): Promise<Membership | null> {
  const row = await db.get<Membership>(`SELECT role, status FROM group_members WHERE group_id = ? AND user_id = ?`, [
    groupId,
    userId,
  ]);
  return row ?? null;
}

export function canModerate(auth: AuthContext, membership: Membership | null): boolean {
  return isStaffModerator(auth) || (membership?.status === 'active' && membership.role === 'moderator');
}

/** May this viewer read the group's posts and members? */
export function canReadGroup(auth: AuthContext, group: GroupRow, membership: Membership | null): boolean {
  return group.privacy === 'public' || membership?.status === 'active' || isStaffModerator(auth);
}

export async function requireGroupModerator(db: Db, auth: AuthContext, groupIdOrSlug: string) {
  const group = await loadGroup(db, auth.customerId, groupIdOrSlug);
  const membership = await membershipOf(db, group.id, auth.userId);
  if (!canModerate(auth, membership)) throw forbidden('Only this group’s moderators can do that.');
  return { group, membership };
}

/** Members (and staff) whose account allows creating groups. */
export async function canCreateGroups(db: Db, auth: AuthContext): Promise<boolean> {
  if (isStaffModerator(auth)) return true;
  const row = await db.get<{ group_permission: string | null; status: string }>(
    `SELECT group_permission, status FROM community_accounts WHERE user_id = ?`,
    [auth.userId],
  );
  return row?.status === 'active' && row.group_permission === 'create';
}

export async function uniqueGroupSlug(db: Db, customerId: string, name: string): Promise<string> {
  const base = slugify(name) || 'group';
  let slug = base;
  for (let i = 2; i < 100; i += 1) {
    const taken = await db.get(`SELECT 1 AS taken FROM community_groups WHERE customer_id = ? AND slug = ?`, [customerId, slug]);
    if (!taken) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${newId().slice(0, 8)}`;
}

/**
 * SQL that is true when the viewer (bound parameter) may read a post given its
 * audience: everyone, or a group-only post in at least one group the viewer
 * can read. Use with `p` as the posts alias.
 */
export function postAudienceVisibleSql(): string {
  return `(p.audience = 'everyone' OR EXISTS (
      SELECT 1 FROM post_groups pg JOIN community_groups g ON g.id = pg.group_id AND g.archived_at IS NULL
       WHERE pg.post_id = p.id
         AND (g.privacy = 'public' OR EXISTS (
               SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active'))))`;
}

/**
 * Validates the groups a post is shared to. Members may only post to groups
 * they belong to; staff (owners/editors) may post to any group.
 */
export async function resolvePostGroups(
  db: Db,
  auth: AuthContext,
  audience: 'everyone' | 'groups',
  rawIds: unknown,
): Promise<string[]> {
  if (audience === 'everyone') return [];
  const ids = Array.isArray(rawIds)
    ? [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && v.length <= 64))]
    : [];
  if (!ids.length) throw badRequest('Choose at least one group to post to.', 'Groups');
  if (ids.length > 10) throw badRequest('Choose up to 10 groups.', 'Groups');
  const staff = isStaffModerator(auth);
  const params: SqlParam[] = [auth.customerId, ...ids];
  const rows = await db.all<{ id: string; member: number }>(
    `SELECT g.id,
            EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active') AS member
       FROM community_groups g
      WHERE g.customer_id = ? AND g.archived_at IS NULL AND g.id IN (${ids.map(() => '?').join(', ')})`,
    [auth.userId, ...params],
  );
  if (rows.length !== ids.length) throw badRequest('One of those groups is not available.', 'Groups');
  if (!staff && rows.some((row) => Number(row.member) !== 1)) {
    throw badRequest('You can only post to groups you have joined.', 'Groups');
  }
  return ids;
}

export function replacePostGroupsWrites(postId: string, customerId: string, groupIds: string[]) {
  return [
    { sql: `DELETE FROM post_groups WHERE post_id = ?`, params: [postId] as SqlParam[] },
    ...groupIds.map((groupId) => ({
      sql: `INSERT OR IGNORE INTO post_groups (post_id, group_id, customer_id) VALUES (?, ?, ?)`,
      params: [postId, groupId, customerId] as SqlParam[],
    })),
  ];
}
