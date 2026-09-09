import { base64UrlToText, bytesToBase64Url, textToBase64Url, timingSafeEqual } from './encoding.ts';

/**
 * Small HMAC-SHA256 signed, time-limited tokens for the handful of genuinely
 * stateless proofs the app needs -- a short-lived document download link, and
 * the OAuth `state` parameter carried through the Microsoft consent redirect.
 * Format: `<base64url(JSON payload)>.<base64url(signature)>`.
 *
 * The main login session is a DB-backed token (see lib/session.ts), not this --
 * that needs to be revocable (sign-out, removing a team member), which a
 * self-contained signed token can never support.
 */

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signValue(
  payload: Record<string, string>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const body = { ...payload, exp: String(Math.floor(Date.now() / 1000) + ttlSeconds) };
  const encoded = textToBase64Url(JSON.stringify(body));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  return `${encoded}.${bytesToBase64Url(signature)}`;
}

export async function verifyValue(
  token: string,
  secret: string,
): Promise<Record<string, string> | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signatureB64] = parts as [string, string];

  const key = await importHmacKey(secret);
  const expectedSignature = bytesToBase64Url(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded)),
  );
  if (!timingSafeEqual(signatureB64, expectedSignature)) return null;

  try {
    const payload = JSON.parse(base64UrlToText(encoded)) as Record<string, string>;
    const exp = Number.parseInt(payload.exp ?? '', 10);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
