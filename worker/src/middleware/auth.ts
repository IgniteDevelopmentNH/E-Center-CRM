import { forbidden, unauthorized } from '../lib/http.ts';
import type { AuthContext, Ctx } from '../router.ts';

/**
 * `ctx.auth` is populated once, centrally, in index.ts before a route handler
 * runs (by verifying the bearer token against the sessions table). These are
 * just the per-handler assertions -- called as the first line of any route
 * that needs them, mirroring the old Express middleware but as plain calls.
 */

export function requireAuth(ctx: Ctx): AuthContext {
  if (!ctx.auth) throw unauthorized();
  return ctx.auth;
}

/** Viewers get read-only access; owners and editors may write. */
export function requireEditor(ctx: Ctx): AuthContext {
  const auth = requireAuth(ctx);
  if (auth.role === 'viewer') throw forbidden('Your account has view-only access.');
  return auth;
}

export function requireOwner(ctx: Ctx): AuthContext {
  const auth = requireAuth(ctx);
  if (auth.role !== 'owner') throw forbidden('Only an account owner can manage team members.');
  return auth;
}
