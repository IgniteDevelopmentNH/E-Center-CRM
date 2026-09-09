import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden, unauthorized } from '../lib/http.ts';
import { verifyToken } from '../lib/jwt.ts';

export interface AuthContext {
  userId: string;
  customerId: string;
  email: string;
  name: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Validates the bearer token and pins the request to one tenant. Route handlers
 * read `auth(req).customerId` and every query filters on it, which is what keeps
 * one customer from ever reading another customer's rows.
 */
export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return next(unauthorized());

  const payload = verifyToken(token);
  if (!payload) return next(unauthorized('Your session has expired. Please sign in again.'));

  req.auth = {
    userId: payload.sub,
    customerId: payload.cid,
    email: payload.email,
    name: payload.name,
    role: payload.role,
  };
  next();
};

/** Viewers get read-only access; owners and editors may write. */
export const requireEditor: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth) return next(unauthorized());
  if (req.auth.role === 'viewer') {
    return next(forbidden('Your account has view-only access.'));
  }
  next();
};

export const requireOwner: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth) return next(unauthorized());
  if (req.auth.role !== 'owner') {
    return next(forbidden('Only an account owner can manage team members.'));
  }
  next();
};

/** Non-null accessor, so handlers do not need `req.auth!` at every use. */
export function auth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
