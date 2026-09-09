import type { Db } from '../db/driver.ts';
import type { Config } from '../env.ts';
import { decryptOptional, decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { isoDaysFromNow, nowIso } from '../lib/time.ts';

/**
 * Outlook calendar integration.
 *
 * Calls the Microsoft Graph REST API directly with the platform's built-in
 * `fetch` -- the surface used here is four endpoints, and this keeps the
 * token-refresh path explicit and dependency-free (no SDK needs Node APIs
 * Workers doesn't have).
 *
 * Client secrets and both tokens are AES-256-GCM encrypted at rest, per customer.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface StoredCredentials {
  id: string;
  customerId: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  accountEmail: string | null;
}

interface CredentialRow {
  id: string;
  customer_id: string;
  client_id: string;
  client_secret_enc: string;
  tenant_id: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
  account_email: string | null;
}

export async function getCredentials(
  db: Db,
  customerId: string,
  encryptionKey: string,
): Promise<StoredCredentials | null> {
  const row = await db.get<CredentialRow>(
    `SELECT * FROM microsoft_oauth_credentials WHERE customer_id = ?`,
    [customerId],
  );
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    clientId: row.client_id,
    clientSecret: await decryptSecret(row.client_secret_enc, encryptionKey),
    tenantId: row.tenant_id,
    accessToken: await decryptOptional(row.access_token_enc, encryptionKey),
    refreshToken: await decryptOptional(row.refresh_token_enc, encryptionKey),
    expiresAt: row.expires_at,
    accountEmail: row.account_email,
  };
}

/** Upserts the app registration for a customer. */
export async function saveAppRegistration(
  db: Db,
  customerId: string,
  input: { clientId: string; clientSecret: string; tenantId: string },
  encryptionKey: string,
): Promise<void> {
  const existing = await db.get<{ id: string }>(
    `SELECT id FROM microsoft_oauth_credentials WHERE customer_id = ?`,
    [customerId],
  );
  const timestamp = nowIso();
  const clientSecretEnc = await encryptSecret(input.clientSecret, encryptionKey);

  if (existing) {
    await db.run(
      `UPDATE microsoft_oauth_credentials
          SET client_id = ?, client_secret_enc = ?, tenant_id = ?, updated_at = ?
        WHERE customer_id = ?`,
      [input.clientId, clientSecretEnc, input.tenantId, timestamp, customerId],
    );
    return;
  }

  await db.run(
    `INSERT INTO microsoft_oauth_credentials
       (id, customer_id, client_id, client_secret_enc, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId(), customerId, input.clientId, clientSecretEnc, input.tenantId, timestamp, timestamp],
  );
}

export async function disconnect(db: Db, customerId: string): Promise<void> {
  // Clears the tokens but keeps the app registration, so reconnecting is one click.
  await db.run(
    `UPDATE microsoft_oauth_credentials
        SET access_token_enc = NULL, refresh_token_enc = NULL, expires_at = NULL,
            account_email = NULL, updated_at = ?
      WHERE customer_id = ?`,
    [nowIso(), customerId],
  );
  await db.run(
    `UPDATE calendar_sync_metadata SET sync_status = 'never', error_message = NULL WHERE customer_id = ?`,
    [customerId],
  );
}

export function authorizeUrl(credentials: StoredCredentials, state: string, config: Config): string {
  const url = new URL(
    `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.microsoft.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', config.microsoft.scopes.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

async function requestTokens(
  credentials: StoredCredentials,
  form: Record<string, string>,
  config: Config,
): Promise<TokenResponse> {
  const response = await fetch(
    `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: config.microsoft.redirectUri,
        scope: config.microsoft.scopes.join(' '),
        ...form,
      }),
    },
  );

  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    throw badRequest(
      `Microsoft rejected the request: ${payload.error_description ?? payload.error ?? response.status}`,
    );
  }
  return payload;
}

async function persistTokens(
  db: Db,
  customerId: string,
  tokens: TokenResponse,
  encryptionKey: string,
  accountEmail?: string | null,
): Promise<void> {
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString();
  const sets = ['access_token_enc = ?', 'expires_at = ?', 'updated_at = ?'];
  const params: (string | null)[] = [await encryptSecret(tokens.access_token, encryptionKey), expiresAt, nowIso()];

  // Microsoft omits refresh_token on some refreshes; keep the existing one then.
  if (tokens.refresh_token) {
    sets.push('refresh_token_enc = ?');
    params.push(await encryptSecret(tokens.refresh_token, encryptionKey));
  }
  if (accountEmail) {
    sets.push('account_email = ?');
    params.push(accountEmail);
  }

  await db.run(
    `UPDATE microsoft_oauth_credentials SET ${sets.join(', ')} WHERE customer_id = ?`,
    [...params, customerId],
  );
}

export async function completeAuthorization(
  db: Db,
  customerId: string,
  code: string,
  config: Config,
): Promise<void> {
  const credentials = await getCredentials(db, customerId, config.encryptionKey);
  if (!credentials) throw badRequest('Add your Microsoft app registration first.');

  const tokens = await requestTokens(credentials, { grant_type: 'authorization_code', code }, config);
  await persistTokens(db, customerId, tokens, config.encryptionKey);

  const profile = await graphFetch<{ mail?: string; userPrincipalName?: string }>(
    tokens.access_token,
    '/me',
  );
  await db.run(`UPDATE microsoft_oauth_credentials SET account_email = ? WHERE customer_id = ?`, [
    profile.mail ?? profile.userPrincipalName ?? null,
    customerId,
  ]);
}

/** Returns a valid access token, refreshing it when it is close to expiry. */
export async function getAccessToken(db: Db, customerId: string, config: Config): Promise<string> {
  const credentials = await getCredentials(db, customerId, config.encryptionKey);
  if (!credentials) throw badRequest('Outlook is not configured for this account.');
  if (!credentials.refreshToken && !credentials.accessToken) {
    throw badRequest('Connect your Outlook calendar first.');
  }

  const stillValid =
    credentials.accessToken && credentials.expiresAt && credentials.expiresAt > nowIso();
  if (stillValid) return credentials.accessToken!;

  if (!credentials.refreshToken) {
    throw badRequest('Your Outlook connection expired. Reconnect it in Settings.');
  }

  const tokens = await requestTokens(
    credentials,
    { grant_type: 'refresh_token', refresh_token: credentials.refreshToken },
    config,
  );
  await persistTokens(db, customerId, tokens, config.encryptionKey);
  return tokens.access_token;
}

async function graphFetch<T>(
  accessToken: string,
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'outlook.timezone="UTC"',
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) return {} as T;
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw badRequest(`Microsoft Graph error: ${payload?.error?.message ?? response.status}`);
  }
  return payload;
}

export interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  lastModifiedDateTime?: string;
}

/** Graph returns naive datetimes alongside a timezone; normalise to ISO UTC. */
function toIso(value?: { dateTime?: string; timeZone?: string }): string | null {
  if (!value?.dateTime) return null;
  const raw = value.dateTime;
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toGraphBody(event: {
  name: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  description: string | null;
}) {
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : new Date(start.getTime() + 60 * 60 * 1000);
  return {
    subject: event.name,
    body: { contentType: 'Text', content: event.description ?? '' },
    start: { dateTime: start.toISOString().replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: end.toISOString().replace('Z', ''), timeZone: 'UTC' },
    location: { displayName: event.location ?? '' },
  };
}

export async function listRemoteEvents(accessToken: string, days = 30): Promise<GraphEvent[]> {
  const payload = await graphFetch<{ value: GraphEvent[] }>(accessToken, '/me/calendarView', {
    query: {
      startDateTime: new Date().toISOString(),
      endDateTime: isoDaysFromNow(days),
      $top: '150',
      $select: 'id,subject,bodyPreview,location,start,end,lastModifiedDateTime',
      $orderby: 'start/dateTime',
    },
  });
  return payload.value ?? [];
}

export async function createRemoteEvent(
  accessToken: string,
  event: Parameters<typeof toGraphBody>[0],
): Promise<GraphEvent> {
  return graphFetch<GraphEvent>(accessToken, '/me/events', {
    method: 'POST',
    body: JSON.stringify(toGraphBody(event)),
  });
}

export async function updateRemoteEvent(
  accessToken: string,
  externalId: string,
  event: Parameters<typeof toGraphBody>[0],
): Promise<GraphEvent> {
  return graphFetch<GraphEvent>(accessToken, `/me/events/${encodeURIComponent(externalId)}`, {
    method: 'PATCH',
    body: JSON.stringify(toGraphBody(event)),
  });
}

export async function deleteRemoteEvent(accessToken: string, externalId: string): Promise<void> {
  await graphFetch(accessToken, `/me/events/${encodeURIComponent(externalId)}`, {
    method: 'DELETE',
  });
}

export { toIso as graphDateToIso };
