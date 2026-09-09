import crypto from 'node:crypto';
import { env } from '../env.ts';

/**
 * Minimal HS256 JWT implementation on node:crypto. Stateless sessions need
 * nothing more, and this keeps the dependency surface (and the audit story)
 * small for a customer-hosted deployment.
 */

export interface TokenPayload {
  sub: string; // user id
  cid: string; // customer id -- every query is scoped by this
  email: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signature(data: string): string {
  return crypto.createHmac('sha256', env.jwtSecret).update(data).digest('base64url');
}

export function signToken(
  claims: Omit<TokenPayload, 'iat' | 'exp'>,
  ttlSeconds = env.jwtTtlSeconds,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  return `${data}.${signature(data)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, provided] = parts as [string, string, string];

  const expected = signature(`${header}.${body}`);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.sub || !payload.cid) return null;
    return payload;
  } catch {
    return null;
  }
}
