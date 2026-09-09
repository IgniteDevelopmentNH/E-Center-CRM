import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.ts';

/**
 * Document storage.
 *
 * `r2`    -- Cloudflare R2 over the S3 API. Encrypted at rest (AES-256 by
 *            default on R2), private bucket, downloads via pre-signed URLs.
 * `local` -- filesystem, so the app runs end to end without cloud credentials.
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
  const extension = path.extname(fileName).toLowerCase();
  return extensions.includes(extension);
}

/**
 * Reduces a client-supplied name to a safe basename. This is an allow-list
 * rather than a block-list: anything outside letters, digits, dot, underscore
 * and hyphen collapses to an underscore, which rules out path separators,
 * control characters and shell metacharacters in one rule.
 */
export function safeFileName(fileName: string): string {
  const base = path
    .basename(fileName)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '');
  return base.slice(-180) || 'file';
}

export function buildStorageKey(customerId: string, fileName: string): string {
  return `customers/${customerId}/documents/${Date.now()}-${safeFileName(fileName)}`;
}

let s3Client: import('@aws-sdk/client-s3').S3Client | null = null;

async function getS3() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  if (!s3Client) {
    if (!env.r2.endpoint || !env.r2.accessKeyId) {
      throw new Error('STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
    }
    s3Client = new S3Client({
      region: 'auto',
      endpoint: env.r2.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.r2.accessKeyId,
        secretAccessKey: env.r2.secretAccessKey,
      },
    });
  }
  return s3Client;
}

function localPathFor(key: string): string {
  // Keys are generated server-side, but normalise defensively before touching disk.
  const normalised = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
  return path.join(env.localUploadDir, normalised);
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (env.storageDriver === 'r2') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    await client.send(
      new PutObjectCommand({
        Bucket: env.r2.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return;
  }

  const target = localPathFor(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

/**
 * A time-limited download URL for R2. The local driver returns null and the
 * route streams the bytes behind a short-lived signed token instead.
 */
export async function getPresignedUrl(key: string, fileName: string): Promise<string | null> {
  if (env.storageDriver !== 'r2') return null;
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = await getS3();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeFileName(fileName)}"`,
    }),
    { expiresIn: env.downloadUrlTtlSeconds },
  );
}

export async function getObject(key: string): Promise<Buffer> {
  if (env.storageDriver === 'r2') {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    const result = await client.send(new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error('That file could not be read from storage.');
    return Buffer.from(bytes);
  }
  return fs.readFile(localPathFor(key));
}

/**
 * Removes the stored bytes. The `documents` row is soft-deleted separately and
 * kept for the audit trail.
 */
export async function deleteObject(key: string): Promise<void> {
  if (env.storageDriver === 'r2') {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    await client.send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }));
    return;
  }
  await fs.rm(localPathFor(key), { force: true });
}
