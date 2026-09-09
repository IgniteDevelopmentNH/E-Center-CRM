import { createD1Db } from './db/d1.ts';
import type { Env } from './env.ts';
import { loadConfig } from './env.ts';
import { errorToResponse, jsonResponse } from './lib/http.ts';
import { getSessionUser } from './lib/session.ts';
import { Router } from './router.ts';
import type { Ctx } from './router.ts';
import { register as registerAuth } from './routes/auth.ts';
import { register as registerCalendar } from './routes/calendar.ts';
import { register as registerContacts } from './routes/contacts.ts';
import { register as registerDashboard } from './routes/dashboard.ts';
import { register as registerDocuments } from './routes/documents.ts';
import { register as registerEvents } from './routes/events.ts';
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
  .use(registerCalendar);

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Requests outside /api/* are the built React app: static files, or the
    // SPA's index.html fallback for a client-side route like /contacts.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(req);
    }

    if (url.pathname === '/api/health') {
      return withCors(jsonResponse({ ok: true, database: 'd1', storage: 'r2' }), origin);
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
        return withCors(jsonResponse({ error: 'Endpoint not found.' }, { status: 404 }), origin);
      }
      ctx.params = matched.params;

      const response = await matched.handler(ctx);
      return withCors(response, origin);
    } catch (error) {
      return withCors(errorToResponse(error, true), origin);
    }
  },
};
