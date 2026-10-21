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

/**
 * Columns added to tables that already existed. `CREATE TABLE IF NOT EXISTS`
 * skips an existing table, so a dev database created before a column was added
 * would never get it from schema.sql alone; add any that are missing first (the
 * same ALTERs the dated files in src/db/migrations/ apply to production).
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'users', column: 'email_verified_at', definition: 'TEXT' },
  { table: 'events', column: 'community_visible', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // 2026-10-20-community-v2
  { table: 'community_accounts', column: 'post_permission', definition: 'TEXT' },
  { table: 'community_accounts', column: 'resume_public', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'community_accounts', column: 'notify_messages', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'community_accounts', column: 'notify_mentions', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'community_accounts', column: 'notify_announcements', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'interest_tags', column: 'featured', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'posts', column: 'author_kind', definition: "TEXT NOT NULL DEFAULT 'staff'" },
  { table: 'posts', column: 'review_note', definition: 'TEXT' },
  { table: 'posts', column: 'reviewed_by', definition: 'TEXT' },
  { table: 'posts', column: 'reviewed_at', definition: 'TEXT' },
  { table: 'posts', column: 'event_starts_at', definition: 'TEXT' },
  { table: 'posts', column: 'event_ends_at', definition: 'TEXT' },
  { table: 'posts', column: 'event_location', definition: 'TEXT' },
  { table: 'posts', column: 'rsvp_enabled', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'posts', column: 'notified_at', definition: 'TEXT' },
  { table: 'posts', column: 'deleted_by', definition: 'TEXT' },
  { table: 'events', column: 'community_details', definition: 'TEXT' },
  { table: 'events', column: 'community_rsvp', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'events', column: 'community_notified_at', definition: 'TEXT' },
];

function main(): void {
  const schema = fs.readFileSync(path.join(workerRoot, 'src', 'db', 'schema.sql'), 'utf8');
  const db = createFakeD1(dbPath);
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const tableExists = db._raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!tableExists) continue;
    const columns = db._raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      db._raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`  added ${table}.${column}`);
    }
  }
  db._raw.exec(schema);
  db._close();
  console.log(`Schema applied (local dev D1 shim): ${dbPath}`);
}

main();
