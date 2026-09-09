/**
 * UNH ECenter CRM -- local dev server.
 *
 * Runs the REAL Worker (src/index.ts) against Node-backed shims for the
 * Cloudflare bindings, so local testing exercises the exact production code
 * path:
 *   DB     -> fakeD1.mjs, backed by node:sqlite (../data/dev.db)
 *   DOCS   -> fakeR2.mjs, backed by the filesystem (../data/uploads)
 *   ASSETS -> fakeAssets.mjs, serving ../../client/dist (run `npm run build`
 *             in client/ first, or `npm run dev:web` for the Vite dev server
 *             and point the browser at :5173, which proxies /api to here)
 *
 * Why not `wrangler dev`? Its bundled `workerd` has no win32-arm64 build.
 * Node 24 has everything the worker needs globally (crypto.subtle, Request,
 * Response, URL) plus native TypeScript stripping, so importing src/index.ts
 * directly just works.
 *
 * Usage:  npm run dev   ->  http://localhost:8788
 * Reset local data: delete worker/data/dev.db and worker/data/uploads/.
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.ts';
import { createFakeAssets } from './fakeAssets.mjs';
import { createFakeD1 } from './fakeD1.mjs';
import { createFakeR2 } from './fakeR2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '..');
const repoRoot = path.resolve(workerRoot, '..');

const PORT = process.env.PORT || 8788;
const DB = createFakeD1(process.env.DEV_SQLITE_PATH || path.join(workerRoot, 'data', 'dev.db'));
const DOCS = createFakeR2(process.env.DEV_UPLOAD_DIR || path.join(workerRoot, 'data', 'uploads'));
const ASSETS = createFakeAssets(path.join(repoRoot, 'client', 'dist'));

const env = {
  DB,
  DOCS,
  ASSETS,
  DEFAULT_CUSTOMER_SLUG: process.env.DEFAULT_CUSTOMER_SLUG || 'unh-ecenter',
  DEFAULT_CUSTOMER_NAME: process.env.DEFAULT_CUSTOMER_NAME || 'UNH Entrepreneurship Center',
  DOWNLOAD_URL_TTL_SECONDS: process.env.DOWNLOAD_URL_TTL_SECONDS || '900',
  UPLOAD_MAX_BYTES: process.env.UPLOAD_MAX_BYTES || '52428800',
  JWT_TTL_SECONDS: process.env.JWT_TTL_SECONDS || '43200',
  JWT_TTL_REMEMBER_SECONDS: process.env.JWT_TTL_REMEMBER_SECONDS || '2592000',
  MICROSOFT_REDIRECT_URI:
    process.env.MICROSOFT_REDIRECT_URI || `http://localhost:${PORT}/api/calendar/microsoft/callback`,
  APP_URL: process.env.APP_URL || 'http://localhost:5173',
  JWT_SECRET: process.env.JWT_SECRET,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};

if (!env.JWT_SECRET || !env.ENCRYPTION_KEY) {
  console.warn(
    '[dev] JWT_SECRET / ENCRYPTION_KEY not set -- using insecure fixed dev values. Set them in .env for anything beyond local testing.',
  );
  env.JWT_SECRET ??= 'dev-only-token-secret-do-not-ship';
  env.ENCRYPTION_KEY ??= 'dev-only-encryption-key-do-not-ship';
}

createServer(async (nodeReq, nodeRes) => {
  try {
    const url = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const request = new Request(url, {
      method: nodeReq.method,
      headers: nodeReq.headers,
      body: nodeReq.method === 'GET' || nodeReq.method === 'HEAD' ? undefined : body,
    });

    const response = await worker.fetch(request, env);
    nodeRes.statusCode = response.status;
    response.headers.forEach((value, key) => nodeRes.setHeader(key, value));
    const buffer = Buffer.from(await response.arrayBuffer());
    nodeRes.end(buffer);
  } catch (error) {
    nodeRes.statusCode = 500;
    nodeRes.setHeader('Content-Type', 'application/json');
    nodeRes.end(JSON.stringify({ error: 'dev server error', detail: String(error?.stack || error) }));
  }
}).listen(PORT, () => {
  console.log(`\n  UNH ECenter CRM -- dev server`);
  console.log(`  -> http://localhost:${PORT}`);
  console.log(`  -> client dev server (Vite, proxies /api here): npm run dev:web\n`);
});
