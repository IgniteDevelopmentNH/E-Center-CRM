import type { NextFunction, Request, Response } from 'express';

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

/** Wraps an async route so rejected promises reach the error middleware. */
export function route(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0]!.trim();
  return req.ip ?? '';
}

export function userAgent(req: Request): string {
  return String(req.headers['user-agent'] ?? '').slice(0, 500);
}
