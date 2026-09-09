import { base64ToBytes, bytesToBase64 } from './encoding.ts';

/**
 * AES-256-GCM envelope encryption for secrets at rest (Microsoft OAuth client
 * secrets, access/refresh tokens). Any-length secret is normalised to a 256-bit
 * key via SHA-256 -- the input is expected to be high-entropy random material
 * (ENCRYPTION_KEY), not a human password. Same envelope shape and derivation
 * as the other Cloudflare Workers in this account, so a payload is recognisable
 * across projects: `{"v":1,"enc":"aesgcm","iv":"...","ct":"..."}`.
 */

const keyCache = new Map<string, CryptoKey>();

async function importKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  keyCache.set(secret, key);
  return key;
}

interface Envelope {
  v: 1;
  enc: 'aesgcm';
  iv: string;
  ct: string;
}

export async function encryptSecret(plaintext: string, secretKey: string): Promise<string> {
  const key = await importKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV per record
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const envelope: Envelope = { v: 1, enc: 'aesgcm', iv: bytesToBase64(iv), ct: bytesToBase64(ciphertext) };
  return JSON.stringify(envelope);
}

export async function decryptSecret(payload: string, secretKey: string): Promise<string> {
  const envelope = JSON.parse(payload) as Partial<Envelope>;
  if (envelope.enc !== 'aesgcm' || !envelope.iv || !envelope.ct) {
    throw new Error('Encrypted payload is malformed or uses an unknown format.');
  }
  const key = await importKey(secretKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ct),
  );
  return new TextDecoder().decode(plaintext);
}

export async function decryptOptional(
  payload: string | null | undefined,
  secretKey: string,
): Promise<string | null> {
  if (!payload) return null;
  try {
    return await decryptSecret(payload, secretKey);
  } catch {
    return null;
  }
}
