import crypto from 'node:crypto';
import { env } from '../env.ts';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Envelope-encrypts a secret (OAuth client secrets, access/refresh tokens) for
 * storage at rest. Format: `v1:<iv>:<authTag>:<ciphertext>`, all base64.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, env.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Encrypted payload is malformed or uses an unknown version.');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    env.encryptionKey,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Nullable variant for optional token columns. */
export function decryptOptional(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decryptSecret(payload);
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
