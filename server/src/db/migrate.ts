import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.ts';
import { closeDb, getDb } from './index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies schema.sql. Every statement is `IF NOT EXISTS`, so this is idempotent
 * and safe to run on every deploy.
 */
export async function migrate(): Promise<void> {
  const db = await getDb();
  const schema = await fs.readFile(path.join(here, 'schema.sql'), 'utf8');
  await db.exec(schema);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  migrate()
    .then(async () => {
      const target = env.dbDriver === 'postgres' ? env.databaseUrl.replace(/:[^:@/]*@/, ':***@') : env.sqlitePath;
      console.log(`Schema applied (${env.dbDriver}): ${target}`);
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error('Migration failed:', error);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
