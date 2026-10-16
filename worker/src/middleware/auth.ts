import type { Db } from '../db/driver.ts';
import { forbidden, unauthorized } from '../lib/http.ts';
import type { AuthContext, Ctx } from '../router.ts';

/**
 * `ctx.auth` is populated once, centrally, in index.ts before a route handler
 * runs (by verifying the bearer token against the sessions table). These are
 * just the per-handler assertions -- called as the first line of any route
 * that needs them, mirroring the old Express middleware but as plain calls.
 *
 * Two kinds of people sign in to the same Worker:
 *   * Staff -- users.role owner | editor | viewer. Administrative permissions.
 *   * Community members -- users.role = 'member'. Students and mentors. Their
 *     account type (student/mentor) lives on community_accounts and is NOT an
 *     administrative role: choosing "Mentor" at signup grants nothing here.
 *
 * Every CRM route calls requireStaff (or requireEditor/requireOwner, which
 * build on it), so a member session is refused by default -- including on any
 * CRM route added later that forgets to think about members.
 */

export const STAFF_ROLES = ['owner', 'editor', 'viewer'] as const;
export const MEMBER_ROLE = 'member';

export function isStaffRole(role: string | null | undefined): boolean {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role);
}

/** Any signed-in person, staff or community member. Use only for self-service routes. */
export function requireSession(ctx: Ctx): AuthContext {
  if (!ctx.auth) throw unauthorized();
  return ctx.auth;
}

/** Administrative CRM access: owners, editors and viewers. Never community members. */
export function requireStaff(ctx: Ctx): AuthContext {
  const auth = requireSession(ctx);
  if (!isStaffRole(auth.role)) throw forbidden('This area is for ECenter staff.');
  return auth;
}

/** Viewers get read-only access; owners and editors may write. */
export function requireEditor(ctx: Ctx): AuthContext {
  const auth = requireStaff(ctx);
  if (auth.role === 'viewer') throw forbidden('Your account has view-only access.');
  return auth;
}

export function requireOwner(ctx: Ctx): AuthContext {
  const auth = requireStaff(ctx);
  if (auth.role !== 'owner') throw forbidden('Only an account owner can manage team members.');
  return auth;
}

/* ------------------------------------------------------------ community -- */

export interface CommunityAccountRow {
  user_id: string;
  customer_id: string;
  account_type: 'student' | 'mentor' | 'staff';
  status: 'pending' | 'active' | 'deactivated';
  onboarding_completed_at: string | null;
}

export async function getCommunityAccount(db: Db, userId: string): Promise<CommunityAccountRow | undefined> {
  return db.get<CommunityAccountRow>(
    `SELECT user_id, customer_id, account_type, status, onboarding_completed_at
       FROM community_accounts WHERE user_id = ?`,
    [userId],
  );
}

/**
 * May read community content (feed, community events, directory, mentors):
 * an ACTIVE community member, or any staff user (they author the feed and may
 * look at the portal without creating a community identity).
 */
export async function requireCommunityViewer(
  ctx: Ctx,
): Promise<{ auth: AuthContext; account: CommunityAccountRow | null }> {
  const auth = requireSession(ctx);
  const account = (await getCommunityAccount(ctx.db, auth.userId)) ?? null;
  if (isStaffRole(auth.role)) return { auth, account: account?.status === 'active' ? account : null };
  if (!account) throw forbidden('Finish creating your community account first.');
  if (account.status === 'deactivated') throw forbidden('This community account has been deactivated.');
  if (account.status !== 'active') {
    throw forbidden('Verify your email and finish signing up to see the community.');
  }
  return { auth, account };
}

/**
 * Acts AS a community identity (messaging, meeting requests): the caller's own
 * community account must exist and be active. Staff are held to the same rule
 * -- administrative access never substitutes for a community identity.
 */
export async function requireActiveCommunityMember(
  ctx: Ctx,
): Promise<{ auth: AuthContext; account: CommunityAccountRow }> {
  const auth = requireSession(ctx);
  const account = await getCommunityAccount(ctx.db, auth.userId);
  if (!account) {
    throw forbidden(
      isStaffRole(auth.role)
        ? 'Create your community profile before messaging members.'
        : 'Finish creating your community account first.',
    );
  }
  if (account.status === 'deactivated') throw forbidden('This community account has been deactivated.');
  if (account.status !== 'active') throw forbidden('Verify your email and finish signing up first.');
  return { auth, account };
}

/** The caller's own community account, in any state but deactivated (for onboarding/profile edits). */
export async function requireOwnCommunityAccount(
  ctx: Ctx,
): Promise<{ auth: AuthContext; account: CommunityAccountRow }> {
  const auth = requireSession(ctx);
  const account = await getCommunityAccount(ctx.db, auth.userId);
  if (!account) throw forbidden('You do not have a community account yet.');
  if (account.status === 'deactivated') throw forbidden('This community account has been deactivated.');
  return { auth, account };
}
