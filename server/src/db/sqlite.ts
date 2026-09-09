import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row, SqlParam } from './driver.ts';
import { normaliseParams } from './driver.ts';

/**
 * Local development / demo driver. Uses `node:sqlite`, built into Node 22.18+,
 * so there is no native compilation step (this project is developed on
 * Windows ARM64 where node-gyp builds are unavailable).
 */
export function createSqliteDb(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = new DatabaseSync(filePath);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');

  let depth = 0;

  const db: Db = {
    dialect: 'sqlite',

    async all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const rows = handle.prepare(sql).all(...normaliseParams(params, sql));
      // node:sqlite returns null-prototype objects; spread into plain objects so
      // they serialise and destructure predictably downstream.
      return rows.map((row) => ({ ...row })) as T[];
    },

    async get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
      const row = handle.prepare(sql).get(...normaliseParams(params, sql));
      return row === undefined ? undefined : ({ ...row } as T);
    },

    async run(sql: string, params?: SqlParam[]): Promise<void> {
      handle.prepare(sql).run(...normaliseParams(params, sql));
    },

    async exec(sql: string): Promise<void> {
      handle.exec(sql);
    },

    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // SQLite has one connection here, so nested calls join the outer transaction
      // rather than deadlocking on a second BEGIN.
      if (depth > 0) return fn(db);
      depth += 1;
      handle.exec('BEGIN');
      try {
        const result = await fn(db);
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        handle.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },

    async close(): Promise<void> {
      handle.close();
    },
  };

  return db;
}
