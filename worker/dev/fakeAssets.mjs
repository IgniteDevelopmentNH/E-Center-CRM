/**
 * A local stand-in for the `[assets]` binding (env.ASSETS.fetch(request)),
 * serving the built client from client/dist with the same
 * not_found_handling = "single-page-application" fallback wrangler.toml
 * configures for production: an unmatched path serves index.html so client-
 * side routes like /contacts work on a hard refresh.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function createFakeAssets(distDir) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let relative = decodeURIComponent(url.pathname);
      if (relative.endsWith('/')) relative += 'index.html';

      const safe = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
      let file = path.join(distDir, safe);

      if (!existsSync(file) || file.endsWith(path.sep)) {
        // SPA fallback for any client-side route (e.g. /contacts).
        file = path.join(distDir, 'index.html');
        if (!existsSync(file)) {
          return new Response('Not found -- run `npm run build` first.', { status: 404 });
        }
      }

      const ext = file.slice(file.lastIndexOf('.'));
      const body = readFileSync(file);
      return new Response(body, { headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' } });
    },
  };
}
