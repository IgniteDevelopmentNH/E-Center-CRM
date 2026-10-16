import { badRequest } from './http.ts';
import { optionalString } from './validate.ts';

/** Validation specific to community profiles. Every helper throws a 400 naming the field. */

/** Trim + lowercase. The ONLY normalisation applied to emails for CRM matching. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

function parseHttpsUrl(raw: string, field: string): URL {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw badRequest(`${field} must be a valid web address.`, field);
  }
  if (url.protocol !== 'https:') throw badRequest(`${field} must start with https://.`, field);
  if (url.username || url.password) throw badRequest(`${field} must not contain a username or password.`, field);
  if (!url.hostname.includes('.')) throw badRequest(`${field} must be a valid web address.`, field);
  return url;
}

/** A LinkedIn profile or company page: https://(www.)linkedin.com/in/... */
export function optionalLinkedInUrl(value: unknown, field = 'LinkedIn URL'): string | null {
  const raw = optionalString(value, field, { max: 300 });
  if (!raw) return null;
  const url = parseHttpsUrl(raw, field);
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
    throw badRequest(`${field} must be a linkedin.com address.`, field);
  }
  if (!/^\/(in|pub|company|school)\/[^/]+/i.test(url.pathname)) {
    throw badRequest(`${field} should look like https://www.linkedin.com/in/your-name.`, field);
  }
  url.hash = '';
  return url.toString();
}

/** Any https booking page (Calendly, Microsoft Bookings, Google appointment pages...). */
export function optionalSchedulingUrl(value: unknown, field = 'Scheduling link'): string | null {
  const raw = optionalString(value, field, { max: 500 });
  if (!raw) return null;
  return parseHttpsUrl(raw, field).toString();
}

/** Optional https/http link on a post. */
export function optionalWebLink(value: unknown, field = 'Link'): string | null {
  const raw = optionalString(value, field, { max: 500 });
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw badRequest(`${field} must be a valid web address.`, field);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest(`${field} must be a web address (https://...).`, field);
  }
  return url.toString();
}

export function optionalGraduationYear(value: unknown, field = 'Graduation year'): number | null {
  if (value === undefined || value === null || value === '') return null;
  const year = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  const current = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < current - 80 || year > current + 10) {
    throw badRequest(`${field} must be a four-digit year.`, field);
  }
  return year;
}

export function password(value: unknown, field = 'Password'): string {
  if (typeof value !== 'string' || !value) throw badRequest(`${field} is required.`, field);
  if (value.length < 8) throw badRequest(`${field} must be at least 8 characters.`, field);
  if (value.length > 200) throw badRequest(`${field} must be 200 characters or fewer.`, field);
  return value;
}

/** Message bodies: required, trimmed, bounded. */
export function messageBody(value: unknown, field = 'Message'): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} cannot be empty.`, field);
  const trimmed = value.trim();
  if (trimmed.length > 4000) throw badRequest(`${field} must be 4,000 characters or fewer.`, field);
  return trimmed;
}
