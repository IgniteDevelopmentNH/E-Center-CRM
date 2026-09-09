import { env } from '../env.ts';
import type { Db } from './driver.ts';
import { createSqliteDb } from './sqlite.ts';

let instance: Db | null = null;

/** Lazily opens the single shared connection for the configured dialect. */
export async function getDb(): Promise<Db> {
  if (instance) return instance;
  if (env.dbDriver === 'postgres') {
    if (!env.databaseUrl) throw new Error('DB_DRIVER=postgres requires DATABASE_URL.');
    // Imported lazily so local SQLite runs never touch the pg driver.
    const { createPostgresDb } = await import('./postgres.ts');
    instance = createPostgresDb(env.databaseUrl);
  } else {
    instance = createSqliteDb(env.sqlitePath);
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
}

export type { Db, Row, SqlParam } from './driver.ts';
