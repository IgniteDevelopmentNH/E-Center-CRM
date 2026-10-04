import type { R2Bucket } from '@cloudflare/workers-types';
import { decryptBytes, encryptBytes, isEncryptedFile } from '../lib/crypto.ts';

/**
 * Document storage via the R2 binding (`DOCS` in wrangler.toml). No S3 SDK, no
 * access keys, no pre-signed URLs -- the binding talks to R2 directly from
 * inside the Worker, and downloads are served by the Worker itself behind a
 * short-lived signed token (see routes/documents.ts), the same shape whether
 * the bytes come from real R2 or the local filesystem shim used in dev.
 *
 * Keys are namespaced per tenant: customers/{customerId}/documents/{ts}-{name}
 */

export const ALLOWED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
};

/** Rejects anything not on the allow-list, and any extension/type mismatch. */
export function isAllowedFile(mimeType: string, fileName: string): boolean {
  const extensions = ALLOWED_TYPES[mimeType];
  if (!extensions) return false;
  const dot = fileName.lastIndexOf('.');
  const extension = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
  return extensions.includes(extension);
}

/**
 * Reduces a client-supplied name to a safe basename. This is an allow-list
 * rather than a block-list: anything outside letters, digits, dot, underscore
 * and hyphen collapses to an underscore, which rules out path separators,
 * control characters and anything else troublesome in one rule.
 */
export function safeFileName(fileName: string): string {
  const base = fileName
    .split(/[/\\]/)
    .pop()!
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '');
  return base.slice(-180) || 'file';
}

export function buildStorageKey(customerId: string, fileName: string): string {
  return `customers/${customerId}/documents/${Date.now()}-${safeFileName(fileName)}`;
}

/** Encrypts the bytes (AES-256-GCM) before they reach the bucket. */
export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer,
  contentType: string,
  secretKey: string,
): Promise<void> {
  await bucket.put(key, await encryptBytes(body, secretKey), { httpMetadata: { contentType } });
}

/**
 * Reads and decrypts a stored file. A file written before encryption was
 * introduced is returned as-is and re-saved encrypted in place, so older
 * documents convert themselves the first time they are opened.
 */
export async function readObject(
  bucket: R2Bucket,
  key: string,
  secretKey: string,
): Promise<{ body: ArrayBuffer; contentType: string | null }> {
  const object = await bucket.get(key);
  if (!object) throw new Error('That file could not be read from storage.');
  const contentType = object.httpMetadata?.contentType ?? null;
  const raw = new Uint8Array(await object.arrayBuffer());
  if (isEncryptedFile(raw)) {
    return { body: await decryptBytes(raw, secretKey), contentType };
  }
  const plain = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  try {
    await bucket.put(key, await encryptBytes(plain, secretKey), {
      httpMetadata: { contentType: contentType ?? 'application/octet-stream' },
    });
  } catch (error) {
    console.error('[storage] could not encrypt legacy file in place', error);
  }
  return { body: plain, contentType };
}

export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}
