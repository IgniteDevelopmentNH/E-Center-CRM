import { audit } from '../lib/audit.ts';
import { badRequest, jsonResponse, readJson } from '../lib/http.ts';
import { signValue, verifyValue } from '../lib/signedToken.ts';
import { requiredString } from '../lib/validate.ts';
import { requireAuth, requireOwner } from '../middleware/auth.ts';
import type { Ctx, Router } from '../router.ts';
import { syncCalendar } from '../services/calendarSync.ts';
import { authorizeUrl, disconnect, getCredentials, saveAppRegistration } from '../services/graph.ts';

/** Minimal standalone page: this window is opened outside the React app. */
function renderCallback(message: string, ok: boolean, appUrl: string): string {
  const colour = ok ? '#008080' : '#dc3545';
  const safe = message.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char]!);
  return `<!doctype html><meta charset="utf-8"><title>Outlook connection</title>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;margin:0;display:grid;place-items:center;height:100vh">
  <div style="background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12);max-width:420px;text-align:center">
    <div style="width:44px;height:44px;border-radius:50%;background:${colour};margin:0 auto 16px;display:grid;place-items:center;color:#fff;font-size:22px">${ok ? '&check;' : '!'}</div>
    <h1 style="font-size:18px;margin:0 0 8px;color:#003366">${ok ? 'Connected' : 'Could not connect'}</h1>
    <p style="margin:0;color:#4b5563;font-size:14px;line-height:1.5">${safe}</p>
    <p style="margin:20px 0 0"><a href="${appUrl}/settings" style="color:#008080;font-size:14px">Back to settings</a></p>
  </div>
</body>`;
}

export function register(router: Router): void {
  /**
   * OAuth callback. Microsoft redirects the browser here without our session
   * header, so the tenant is carried in a signed, short-lived `state` value.
   */
  router.get('/api/calendar/microsoft/callback', async (ctx: Ctx) => {
    const state = ctx.query.get('state') ?? '';
    const code = ctx.query.get('code') ?? '';
    const payload = await verifyValue(state, ctx.config.tokenSecret);

    if (!payload || payload.purpose !== 'oauth-state') {
      return new Response(
        renderCallback('That sign-in link expired. Try connecting again.', false, ctx.config.appUrl),
        { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }
    if (!code) {
      const reason = ctx.query.get('error_description') || 'No authorization code was returned.';
      return new Response(renderCallback(reason, false, ctx.config.appUrl), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    try {
      const { completeAuthorization } = await import('../services/graph.ts');
      await completeAuthorization(ctx.db, payload.customerId!, code, ctx.config);
      await audit(ctx.db, {
        customerId: payload.customerId!,
        userId: payload.userId,
        action: 'calendar.connect',
        req: ctx.req,
      });
      return new Response(
        renderCallback('Outlook is connected. You can close this tab.', true, ctx.config.appUrl),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed.';
      return new Response(renderCallback(message, false, ctx.config.appUrl), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
  });

  router.get('/api/calendar/status', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const credentials = await getCredentials(ctx.db, customerId, ctx.config.encryptionKey);
    const sync = await ctx.db.get(`SELECT * FROM calendar_sync_metadata WHERE customer_id = ?`, [customerId]);

    return jsonResponse({
      configured: !!credentials,
      connected: !!credentials?.refreshToken,
      accountEmail: credentials?.accountEmail ?? null,
      tenantId: credentials?.tenantId ?? null,
      clientId: credentials?.clientId ?? null,
      redirectUri: ctx.config.microsoft.redirectUri,
      lastSyncAt: sync?.last_sync_at ?? null,
      syncStatus: sync?.sync_status ?? 'never',
      errorMessage: sync?.error_message ?? null,
    });
  });

  /** Stores the Azure app registration. The secret is encrypted before it lands. */
  router.put('/api/calendar/credentials', async (ctx: Ctx) => {
    const { customerId, userId } = requireOwner(ctx);
    const body = await readJson(ctx.req);

    await saveAppRegistration(
      ctx.db,
      customerId,
      {
        clientId: requiredString(body.clientId, 'Application (client) ID', { max: 100 }),
        clientSecret: requiredString(body.clientSecret, 'Client secret', { max: 500 }),
        tenantId: requiredString(body.tenantId ?? 'common', 'Directory (tenant) ID', { max: 100 }),
      },
      ctx.config.encryptionKey,
    );
    await audit(ctx.db, {
      customerId,
      userId,
      action: 'calendar.connect',
      metadata: { step: 'credentials_saved' },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });

  /** Returns the Microsoft consent URL for the client to open. */
  router.post('/api/calendar/authorize', async (ctx: Ctx) => {
    const { customerId, userId } = requireOwner(ctx);
    const credentials = await getCredentials(ctx.db, customerId, ctx.config.encryptionKey);
    if (!credentials) throw badRequest('Save your Microsoft app registration first.');

    // 10-minute signed state, tying the callback back to this tenant and user.
    const state = await signValue(
      { purpose: 'oauth-state', userId, customerId },
      ctx.config.tokenSecret,
      600,
    );
    return jsonResponse({ url: authorizeUrl(credentials, state, ctx.config), redirectUri: ctx.config.microsoft.redirectUri });
  });

  router.post('/api/calendar/sync', async (ctx: Ctx) => {
    const { customerId, userId } = requireAuth(ctx);
    const result = await syncCalendar(ctx.db, customerId, userId, ctx.config);
    return jsonResponse(result);
  });

  router.post('/api/calendar/disconnect', async (ctx: Ctx) => {
    const { customerId, userId } = requireOwner(ctx);
    await disconnect(ctx.db, customerId);
    await audit(ctx.db, { customerId, userId, action: 'calendar.disconnect', req: ctx.req });
    return jsonResponse({ ok: true });
  });
}
