import { badRequest } from './http.ts';

/** Field-level validation. Every helper throws a 400 HttpError naming the field. */

export function requiredString(
  value: unknown,
  field: string,
  { max = 500 }: { max?: number } = {},
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest(`${field} is required.`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${field} must be ${max} characters or fewer.`, field);
  return trimmed;
}

export function optionalString(
  value: unknown,
  field: string,
  { max = 20000 }: { max?: number } = {},
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`, field);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw badRequest(`${field} must be ${max} characters or fewer.`, field);
  return trimmed;
}

export function requiredEmail(value: unknown, field = 'Email'): string {
  const email = requiredString(value, field, { max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest(`${field} must be a valid email address.`, field);
  }
  return email;
}

export function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) {
    return fallback;
  }
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`, field);
}

/** `YYYY-MM-DD`, validated as a real calendar date. */
export function requiredDate(value: unknown, field: string): string {
  const raw = requiredString(value, field, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw badRequest(`${field} must be a YYYY-MM-DD date.`, field);
  const [y, m, d] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  if (date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) {
    throw badRequest(`${field} is not a real date.`, field);
  }
  return raw;
}

export function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredDate(value, field);
}

/** Any parseable datetime, normalised to ISO-8601 UTC. */
export function requiredTimestamp(value: unknown, field: string): string {
  const raw = requiredString(value, field, { max: 40 });
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw badRequest(`${field} must be a valid date and time.`, field);
  return date.toISOString();
}

export function optionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredTimestamp(value, field);
}

/** Normalises a tag list to a de-duplicated JSON array string for storage. */
export function tagList(value: unknown, field = 'Tags', max = 40): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list.`, field);
  const cleaned = value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter((tag) => tag.length > 0 && tag.length <= 60);
  if (cleaned.length > max) throw badRequest(`${field} allows at most ${max} entries.`, field);
  return [...new Set(cleaned)];
}

export function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) throw badRequest(`${field} is invalid.`, field);
  return value;
}

export function flag(value: unknown): 0 | 1 {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  return 0;
}

export function optionalUrl(value: unknown, field: string): string | null {
  const raw = optionalString(value, field, { max: 500 });
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    new URL(withScheme);
  } catch {
    throw badRequest(`${field} must be a valid URL.`, field);
  }
  return withScheme;
}

export function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}
