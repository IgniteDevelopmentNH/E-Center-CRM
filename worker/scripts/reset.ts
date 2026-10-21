/** Empties every table in the local dev database. Development helper only. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1Db } from '../src/db/d1.ts';
// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeD1 } from '../dev/fakeD1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '..');
const dbPath = process.env.DEV_SQLITE_PATH || path.join(workerRoot, 'data', 'dev.db');

/** Child-first order so foreign keys stay satisfied while dropping rows. */
const TABLES = [
  'email_outbox',
  'event_rsvps',
  'post_mentions',
  'post_likes',
  'post_comments',
  'post_revisions',
  'rate_limit_events',
  'messages',
  'conversation_members',
  'conversations',
  'posts',
  'auth_tokens',
  'community_profile_tags',
  'interest_tags',
  'community_profiles',
  'community_accounts',
  'event_external_mapping',
  'calendar_sync_metadata',
  'microsoft_oauth_credentials',
  'audit_logs',
  'documents',
  'event_attendees',
  'events',
  'tasks',
  'note_contacts',
  'notes',
  'contact_organizations',
  'contacts',
  'organizations',
  'sessions',
  'user_preferences',
  'users',
  'customers',
];

async function main(): Promise<void> {
  const fakeD1 = createFakeD1(dbPath);
  const db = createD1Db(fakeD1 as never);
  for (const table of TABLES) {
    await db.run(`DELETE FROM ${table}`);
  }
  fakeD1._close();
  console.log('Local dev database cleared. Run `npm run seed` to reload sample data.');
}

main().catch((error: unknown) => {
  console.error('Reset failed:', error);
  process.exit(1);
});
