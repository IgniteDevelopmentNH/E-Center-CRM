import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(serverRoot, '..');

const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  if (isProd) {
    throw new Error(
      `${name} is required in production. Copy .env.example to .env and set a strong random value.`,
    );
  }
  console.warn(`[env] ${name} not set -- using an insecure development fallback.`);
  return devFallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';

/**
 * Any secret string is normalised to exactly 32 bytes for AES-256-GCM. Supply at
 * least 32 random bytes (`openssl rand -hex 32`) in production.
 */
function key32(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export const env = {
  isProd,
  port: int('PORT', 4000),

  /** `postgres` when DATABASE_URL is present, otherwise local `node:sqlite`. */
  dbDriver: (process.env.DB_DRIVER?.trim() || (databaseUrl ? 'postgres' : 'sqlite')) as
    | 'postgres'
    | 'sqlite',
  databaseUrl,
  sqlitePath: process.env.SQLITE_PATH?.trim() || path.join(serverRoot, 'data', 'ecenter.db'),

  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-do-not-ship'),
  jwtTtlSeconds: int('JWT_TTL_SECONDS', 60 * 60 * 12),
  jwtTtlRememberSeconds: int('JWT_TTL_REMEMBER_SECONDS', 60 * 60 * 24 * 30),
  encryptionKey: key32(required('ENCRYPTION_KEY', 'dev-only-encryption-key-do-not-ship')),

  corsOrigins: (process.env.CORS_ORIGINS?.trim() || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  /** `r2` uses Cloudflare R2 (S3-compatible); `local` writes to server/data/uploads. */
  storageDriver: (process.env.STORAGE_DRIVER?.trim() || (process.env.R2_BUCKET ? 'r2' : 'local')) as
    | 'r2'
    | 'local',
  localUploadDir: process.env.LOCAL_UPLOAD_DIR?.trim() || path.join(serverRoot, 'data', 'uploads'),
  r2: {
    accountId: process.env.R2_ACCOUNT_ID?.trim() ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '',
    bucket: process.env.R2_BUCKET?.trim() || 'crm-documents',
    endpoint:
      process.env.R2_ENDPOINT?.trim() ||
      (process.env.R2_ACCOUNT_ID
        ? `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`
        : ''),
  },

  uploadMaxBytes: int('UPLOAD_MAX_BYTES', 50 * 1024 * 1024),
  downloadUrlTtlSeconds: int('DOWNLOAD_URL_TTL_SECONDS', 15 * 60),

  microsoft: {
    redirectUri:
      process.env.MICROSOFT_REDIRECT_URI?.trim() ||
      'http://localhost:4000/api/calendar/microsoft/callback',
    /** Optional bootstrap values; per-customer credentials live encrypted in the DB. */
    clientId: process.env.MICROSOFT_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET?.trim() ?? '',
    tenantId: process.env.MICROSOFT_TENANT_ID?.trim() || 'common',
    scopes: [
      'offline_access',
      'openid',
      'profile',
      'email',
      'https://graph.microsoft.com/Calendars.ReadWrite',
    ],
  },

  /** Tenant provisioned by `npm run seed`. */
  defaultCustomer: {
    slug: process.env.DEFAULT_CUSTOMER_SLUG?.trim() || 'unh-ecenter',
    name: process.env.DEFAULT_CUSTOMER_NAME?.trim() || 'UNH Entrepreneurship Center',
  },

  appUrl: process.env.APP_URL?.trim() || 'http://localhost:5173',
};

export type Env = typeof env;
