import pg from 'pg';
import type { Db, Row, SqlParam } from './driver.ts';
import { normaliseParams, toPositional } from './driver.ts';

/** Production driver. Rewrites portable `?` placeholders to `$1..$n`. */
export function createPostgresDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: Number.parseInt(process.env.PG_POOL_MAX ?? '10', 10),
    ssl: /sslmode=(require|verify)/.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
  });

  function wrap(runner: pg.Pool | pg.PoolClient, inTransaction: boolean): Db {
    const db: Db = {
      dialect: 'postgres',

      async all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
        const result = await runner.query(toPositional(sql), normaliseParams(params, sql));
        return result.rows as T[];
      },

      async get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
        const result = await runner.query(toPositional(sql), normaliseParams(params, sql));
        return result.rows[0] as T | undefined;
      },

      async run(sql: string, params?: SqlParam[]): Promise<void> {
        await runner.query(toPositional(sql), normaliseParams(params, sql));
      },

      async exec(sql: string): Promise<void> {
        await runner.query(sql);
      },

      async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        if (inTransaction) return fn(db);
        const client = await pool.connect();
        const scoped = wrap(client, true);
        try {
          await client.query('BEGIN');
          const result = await fn(scoped);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },

      async close(): Promise<void> {
        await pool.end();
      },
    };
    return db;
  }

  return wrap(pool, false);
}
