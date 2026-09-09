import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

/**
 * Cloudflare bindings (wrangler.toml) plus vars and secrets. Workers pass this
 * fresh to every request -- there is no module-level singleton the way a
 * long-running Node process would have, so config is derived per-request.
 */
export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  ASSETS: Fetcher;

  // [vars] in wrangler.toml
  DEFAULT_CUSTOMER_SLUG?: string;
  DEFAULT_CUSTOMER_NAME?: string;
  DOWNLOAD_URL_TTL_SECONDS?: string;
  UPLOAD_MAX_BYTES?: string;
  JWT_TTL_SECONDS?: string;
  JWT_TTL_REMEMBER_SECONDS?: string;
  MICROSOFT_REDIRECT_URI?: string;
  APP_URL?: string;

  // Secrets -- set with `wrangler secret put NAME`, never written to this file.
  JWT_SECRET?: string;
  ENCRYPTION_KEY?: string;

  // Temporary secrets for POST /api/bootstrap (see routes/bootstrap.ts). Only
  // needed once, for the very first owner/editor accounts on a fresh
  // database; delete them (`wrangler secret delete NAME`) once used.
  BOOTSTRAP_OWNER_EMAIL?: string;
  BOOTSTRAP_OWNER_NAME?: string;
  BOOTSTRAP_OWNER_PASSWORD?: string;
  BOOTSTRAP_EDITOR_EMAIL?: string;
  BOOTSTRAP_EDITOR_NAME?: string;
  BOOTSTRAP_EDITOR_PASSWORD?: string;
}

export interface Config {
  downloadUrlTtlSeconds: number;
  uploadMaxBytes: number;
  sessionTtlSeconds: number;
  sessionTtlRememberSeconds: number;
  defaultCustomer: { slug: string; name: string };
  microsoft: { redirectUri: string; scopes: string[] };
  appUrl: string;
  tokenSecret: string;
  encryptionKey: string;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads and validates configuration for one request. Throws if a required secret is missing. */
export function loadConfig(env: Env): Config {
  if (!env.JWT_SECRET || !env.ENCRYPTION_KEY) {
    throw new Error(
      'JWT_SECRET and ENCRYPTION_KEY must be set. Run: wrangler secret put JWT_SECRET (and ENCRYPTION_KEY).',
    );
  }

  return {
    downloadUrlTtlSeconds: int(env.DOWNLOAD_URL_TTL_SECONDS, 15 * 60),
    uploadMaxBytes: int(env.UPLOAD_MAX_BYTES, 50 * 1024 * 1024),
    sessionTtlSeconds: int(env.JWT_TTL_SECONDS, 60 * 60 * 12),
    sessionTtlRememberSeconds: int(env.JWT_TTL_REMEMBER_SECONDS, 60 * 60 * 24 * 30),
    defaultCustomer: {
      slug: env.DEFAULT_CUSTOMER_SLUG || 'unh-ecenter',
      name: env.DEFAULT_CUSTOMER_NAME || 'UNH Entrepreneurship Center',
    },
    microsoft: {
      redirectUri: env.MICROSOFT_REDIRECT_URI || '',
      scopes: [
        'offline_access',
        'openid',
        'profile',
        'email',
        'https://graph.microsoft.com/Calendars.ReadWrite',
      ],
    },
    appUrl: env.APP_URL || '',
    tokenSecret: env.JWT_SECRET,
    encryptionKey: env.ENCRYPTION_KEY,
  };
}
