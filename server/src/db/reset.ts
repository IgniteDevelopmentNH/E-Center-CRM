import { closeDb, getDb } from './index.ts';
import { migrate } from './migrate.ts';

/** Child-first order so foreign keys stay satisfied while dropping rows. */
const TABLES = [
  'event_external_mapping',
  'calendar_sync_metadata',
  'microsoft_oauth_credentials',
  'audit_logs',
  'documents',
  'event_attendees',
  'events',
  'tasks',
  'notes',
  'contacts',
  'organizations',
  'user_preferences',
  'users',
  'customers',
];

/** Truncates every table, then re-applies the schema. Development helper. */
export async function reset(): Promise<void> {
  const db = await getDb();
  await migrate();
  await db.tx(async (tx) => {
    for (const table of TABLES) {
      await tx.run(`DELETE FROM ${table}`);
    }
  });
}

if (process.argv[1]?.includes('reset')) {
  reset()
    .then(async () => {
      console.log('Database cleared. Run `npm run seed` to reload sample data.');
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error('Reset failed:', error);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
