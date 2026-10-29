import { createD1Db } from './db/d1.ts';
import type { Env } from './env.ts';
import { loadConfig } from './env.ts';
import { errorToResponse, jsonResponse } from './lib/http.ts';
import { getSessionUser } from './lib/session.ts';
import { Router } from './router.ts';
import type { Ctx } from './router.ts';
import { register as registerAdminCommunity } from './routes/adminCommunity.ts';
import { register as registerAdminPosts } from './routes/adminPosts.ts';
import { register as registerAuth } from './routes/auth.ts';
import { register as registerBootstrap } from './routes/bootstrap.ts';
import { register as registerCalendar } from './routes/calendar.ts';
import { register as registerCommunityAccount } from './routes/communityAccount.ts';
import { register as registerCommunityContent } from './routes/communityContent.ts';
import { register as registerBusinesses } from './routes/businesses.ts';
import { register as registerCommunityPosts } from './routes/communityPosts.ts';
import { register as registerCompetitions } from './routes/competitions.ts';
import { register as registerGroups } from './routes/groups.ts';
import { register as registerPublic } from './routes/public.ts';
import { runScheduledNotifications } from './services/notifications.ts';
import { register as registerContacts } from './routes/contacts.ts';
import { register as registerDashboard } from './routes/dashboard.ts';
import { register as registerDocuments } from './routes/documents.ts';
import { register as registerEvents } from './routes/events.ts';
import { register as registerMessages } from './routes/messages.ts';
import { register as registerNotes } from './routes/notes.ts';
import { register as registerOrganizations } from './routes/organizations.ts';
import { register as registerSearch } from './routes/search.ts';
import { register as registerSettings } from './routes/settings.ts';
import { register as registerTasks } from './routes/tasks.ts';

const router = new Router();
router
  .use(registerAuth)
  .use(registerContacts)
  .use(registerNotes)
  .use(registerTasks)
  .use(registerOrganizations)
  .use(registerEvents)
  .use(registerDashboard)
  .use(registerSearch)
  .use(registerDocuments)
  .use(registerSettings)
  .use(registerCalendar)
  .use(registerBootstrap)
  // Administrative additions (staff only).
  .use(registerAdminPosts)
  .use(registerAdminCommunity)
  // Community portal (students, mentors, staff community identities).
  .use(registerCommunityAccount)
  .use(registerCommunityContent)
  .use(registerCommunityPosts)
  .use(registerGroups)
  .use(registerBusinesses)
  .use(registerCompetitions)
  .use(registerMessages)
  // Guest (no account) read-only access.
  .use(registerPublic);

/**
 * Headers added to every response the Worker produces. Static files served
 * straight from the assets binding bypass the Worker, so the same set lives in
 * client/public/_headers for those.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

/**
 * The SPA is served by this same Worker, so browsers never need CORS in
 * production. Only the app's own origin (and APP_URL, if set) is echoed back;
 * any other origin gets no CORS headers and the browser blocks the read.
 */
function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  };
}

function finalize(response: Response, origin: string | null, allowed: string[], isApi: boolean): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  if (isApi) headers.set('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(corsHeaders(origin, allowed))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const allowed = [url.origin, ...(env.APP_URL ? [new URL(env.APP_URL).origin] : [])];

    if (req.method === 'OPTIONS') {
      return finalize(new Response(null, { status: 204 }), origin, allowed, true);
    }

    // Requests outside /api/* are the built React app: static files, or the
    // SPA's index.html fallback for a client-side route like /contacts.
    if (!url.pathname.startsWith('/api/')) {
      return finalize(await env.ASSETS.fetch(req), origin, allowed, false);
    }

    if (url.pathname === '/api/health') {
      return finalize(jsonResponse({ ok: true, database: 'd1', storage: 'r2' }), origin, allowed, true);
    }

    try {
      const config = loadConfig(env);
      const db = createD1Db(env.DB);

      const authHeader = req.headers.get('Authorization') ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const sessionUser = token ? await getSessionUser(db, token) : null;

      const ctx: Ctx = {
        req,
        env,
        config,
        db,
        url,
        method: req.method,
        pathname: url.pathname,
        params: {},
        query: url.searchParams,
        auth: sessionUser
          ? {
              sessionId: sessionUser.sessionId,
              userId: sessionUser.userId,
              customerId: sessionUser.customerId,
              email: sessionUser.email,
              name: sessionUser.name,
              role: sessionUser.role,
            }
          : null,
        token,
      };

      const matched = router.match(ctx.method, ctx.pathname);
      if (!matched) {
        return finalize(jsonResponse({ error: 'Endpoint not found.' }, { status: 404 }), origin, allowed, true);
      }
      ctx.params = matched.params;

      const response = await matched.handler(ctx);
      return finalize(response, origin, allowed, true);
    } catch (error) {
      return finalize(errorToResponse(error, true), origin, allowed, true);
    }
  },

  /**
   * Cron trigger (wrangler.toml [triggers], every minute): sends queued
   * community notification emails a batch at a time. See services/notifications.ts.
   */
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const result = await runScheduledNotifications(env);
    if (result.claimed) console.log('[notifications]', JSON.stringify(result));
  },
};
