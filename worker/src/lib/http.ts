/** HTTP errors and Request/Response helpers for the hand-rolled router. */

export class HttpError extends Error {
  status: number;
  field?: string;

  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export const badRequest = (message: string, field?: string) => new HttpError(400, message, field);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, message);
export const forbidden = (message = 'You do not have access to this.') => new HttpError(403, message);
export const notFound = (message = 'Not found.') => new HttpError(404, message);

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Converts any thrown value into the single JSON error shape `{ error, field? }`. */
export function errorToResponse(error: unknown, isProd: boolean): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.message, field: error.field }, { status: error.status });
  }
  console.error('[error]', error);
  return jsonResponse(
    {
      error: isProd
        ? 'Something went wrong. Please try again.'
        : String((error as Error)?.message ?? error),
    },
    { status: 500 },
  );
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ??
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    ''
  );
}

export function userAgent(req: Request): string {
  return (req.headers.get('User-Agent') ?? '').slice(0, 500);
}

/** Parses the request body as JSON, throwing a 400 on invalid or missing JSON. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw badRequest('The request body must be valid JSON.');
  }
}
