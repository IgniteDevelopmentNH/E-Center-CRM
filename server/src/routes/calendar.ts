import { Router } from 'express';
import { getDb } from '../db/index.ts';
import { env } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, route } from '../lib/http.ts';
import { signToken, verifyToken } from '../lib/jwt.ts';
import { requiredString } from '../lib/validate.ts';
import { auth, requireAuth, requireOwner } from '../middleware/auth.ts';
import { syncCalendar } from '../services/calendarSync.ts';
import { disconnect, getCredentials, saveAppRegistration, authorizeUrl } from '../services/graph.ts';

export const calendarRouter = Router();

/**
 * OAuth callback. Microsoft redirects the browser here without our session
 * header, so the tenant is carried in a signed, short-lived `state` token.
 * Declared before `requireAuth` for that reason.
 */
calendarRouter.get(
  '/microsoft/callback',
  route(async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const payload = verifyToken(state);

    if (!payload || payload.role !== 'oauth-state') {
      res.status(400).send(renderCallback('That sign-in link expired. Try connecting again.', false));
      return;
    }
    if (!code) {
      const reason = typeof req.query.error_description === 'string' ? req.query.error_description : 'No authorization code was returned.';
      res.status(400).send(renderCallback(reason, false));
      return;
    }

    const db = await getDb();
    try {
      const { completeAuthorization } = await import('../services/graph.ts');
      await completeAuthorization(db, payload.cid, code);
      await audit(db, {
        customerId: payload.cid,
        userId: payload.sub,
        action: 'calendar.connect',
        req,
      });
      res.send(renderCallback('Outlook is connected. You can close this tab.', true));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed.';
      res.status(400).send(renderCallback(message, false));
    }
  }),
);

/** Minimal standalone page: this window is opened outside the React app. */
function renderCallback(message: string, ok: boolean): string {
  const colour = ok ? '#008080' : '#dc3545';
  const safe = message.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char]!);
  return `<!doctype html><meta charset="utf-8"><title>Outlook connection</title>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;margin:0;display:grid;place-items:center;height:100vh">
  <div style="background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12);max-width:420px;text-align:center">
    <div style="width:44px;height:44px;border-radius:50%;background:${colour};margin:0 auto 16px;display:grid;place-items:center;color:#fff;font-size:22px">${ok ? '&check;' : '!'}</div>
    <h1 style="font-size:18px;margin:0 0 8px;color:#003366">${ok ? 'Connected' : 'Could not connect'}</h1>
    <p style="margin:0;color:#4b5563;font-size:14px;line-height:1.5">${safe}</p>
    <p style="margin:20px 0 0"><a href="${env.appUrl}/settings" style="color:#008080;font-size:14px">Back to settings</a></p>
  </div>
</body>`;
}

calendarRouter.use(requireAuth);

calendarRouter.get(
  '/status',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const credentials = await getCredentials(db, customerId);
    const sync = await db.get(`SELECT * FROM calendar_sync_metadata WHERE customer_id = ?`, [customerId]);

    res.json({
      configured: !!credentials,
      connected: !!credentials?.refreshToken,
      accountEmail: credentials?.accountEmail ?? null,
      tenantId: credentials?.tenantId ?? null,
      clientId: credentials?.clientId ?? null,
      redirectUri: env.microsoft.redirectUri,
      lastSyncAt: sync?.last_sync_at ?? null,
      syncStatus: sync?.sync_status ?? 'never',
      errorMessage: sync?.error_message ?? null,
    });
  }),
);

/** Stores the Azure app registration. The secret is encrypted before it lands. */
calendarRouter.put(
  '/credentials',
  requireOwner,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const db = await getDb();

    await saveAppRegistration(db, customerId, {
      clientId: requiredString(body.clientId, 'Application (client) ID', { max: 100 }),
      clientSecret: requiredString(body.clientSecret, 'Client secret', { max: 500 }),
      tenantId: requiredString(body.tenantId ?? 'common', 'Directory (tenant) ID', { max: 100 }),
    });
    await audit(db, {
      customerId,
      userId,
      action: 'calendar.connect',
      metadata: { step: 'credentials_saved' },
      req,
    });
    res.json({ ok: true });
  }),
);

/** Returns the Microsoft consent URL for the client to open. */
calendarRouter.post(
  '/authorize',
  requireOwner,
  route(async (req, res) => {
    const { customerId, userId, email, name } = auth(req);
    const db = await getDb();
    const credentials = await getCredentials(db, customerId);
    if (!credentials) throw badRequest('Save your Microsoft app registration first.');

    // 10-minute signed state, tying the callback back to this tenant and user.
    const state = signToken({ sub: userId, cid: customerId, email, name, role: 'oauth-state' }, 600);
    res.json({ url: authorizeUrl(credentials, state), redirectUri: env.microsoft.redirectUri });
  }),
);

calendarRouter.post(
  '/sync',
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const result = await syncCalendar(db, customerId, userId);
    res.json(result);
  }),
);

calendarRouter.post(
  '/disconnect',
  requireOwner,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    await disconnect(db, customerId);
    await audit(db, { customerId, userId, action: 'calendar.disconnect', req });
    res.json({ ok: true });
  }),
);
