import { bufToHex, hexToBuf, timingSafeEqual } from './encoding.ts';

/**
 * PBKDF2-SHA256 password hashing via Web Crypto (no bcrypt -- Workers has no
 * native module support, and this is the same mechanism the other Cloudflare
 * apps in this account already use). Stored as a single self-describing
 * column: `pbkdf2:<iterations>:<saltHex>:<hashHex>`.
 */

const ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

async function derive(password: string, saltHex: string, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBuf(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return bufToHex(derived);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = bufToHex(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2:${ITERATIONS}:${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iterationsRaw, salt, expectedHash] = parts;
  const iterations = Number.parseInt(iterationsRaw!, 10);
  if (!Number.isFinite(iterations) || !salt || !expectedHash) return false;
  const actualHash = await derive(password, salt, iterations);
  return timingSafeEqual(actualHash, expectedHash);
}
