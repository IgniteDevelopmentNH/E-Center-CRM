/**
 * Applies schema.sql to the local dev database (worker/data/dev.db).
 *
 * For production, D1 has no equivalent of a persistent Node connection to run
 * this script against, so the real migration path is:
 *   wrangler d1 execute ecenter-crm --remote --file=./worker/src/db/schema.sql
 * (see README -- Deployment).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeD1 } from '../dev/fakeD1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '..');
const dbPath = process.env.DEV_SQLITE_PATH || path.join(workerRoot, 'data', 'dev.db');

function main(): void {
  const schema = fs.readFileSync(path.join(workerRoot, 'src', 'db', 'schema.sql'), 'utf8');
  const db = createFakeD1(dbPath);
  db._raw.exec(schema);
  db._close();
  console.log(`Schema applied (local dev D1 shim): ${dbPath}`);
}

main();
