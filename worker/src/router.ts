import type { Db } from './db/driver.ts';
import type { Config, Env } from './env.ts';

export interface AuthContext {
  sessionId: string;
  userId: string;
  customerId: string;
  email: string;
  name: string;
  role: string;
}

/** Everything a route handler needs. Built fresh for every incoming request. */
export interface Ctx {
  req: Request;
  env: Env;
  config: Config;
  db: Db;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
  query: URLSearchParams;
  auth: AuthContext | null;
  /** The raw bearer token, if one was sent -- needed only by logout (to revoke it). */
  token: string | null;
}

export type Handler = (ctx: Ctx) => Promise<Response>;

interface RouteDef {
  method: string;
  segments: string[];
  handler: Handler;
}

/**
 * Minimal method + path router with `:param` segments. Handlers are plain
 * async functions returning a Response; errors are caught once, centrally, in
 * the top-level fetch() in index.ts rather than wrapped per-route.
 */
export class Router {
  private routes: RouteDef[] = [];

  private add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }
  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Registers every route from a module's `register(router)` export. Keeps index.ts a flat list. */
  use(register: (router: Router) => void): this {
    register(this);
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const pathSegments = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const patternSegment = route.segments[i]!;
        const pathSegment = pathSegments[i]!;
        if (patternSegment.startsWith(':')) {
          params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
        } else if (patternSegment !== pathSegment) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}
