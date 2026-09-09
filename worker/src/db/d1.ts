import type { D1Database } from '@cloudflare/workers-types';
import type { Db, Row, SqlParam } from './driver.ts';
import { normaliseParams } from './driver.ts';

/**
 * Production driver, backed by a real D1 binding. The local-dev/test shim
 * (worker/dev/fakeD1.mjs) implements the same `D1Database` surface over
 * node:sqlite, so this file runs unmodified in both environments -- only what
 * is passed in as `d1` differs.
 */
export function createD1Db(d1: D1Database): Db {
  return {
    async all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const stmt = d1.prepare(sql).bind(...normaliseParams(params, sql));
      const result = await stmt.all<T>();
      return result.results ?? [];
    },

    async get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
      const stmt = d1.prepare(sql).bind(...normaliseParams(params, sql));
      const row = await stmt.first<T>();
      return row ?? undefined;
    },

    async run(sql: string, params?: SqlParam[]): Promise<void> {
      const stmt = d1.prepare(sql).bind(...normaliseParams(params, sql));
      await stmt.run();
    },

    async batch(writes: { sql: string; params?: SqlParam[] }[]): Promise<void> {
      if (!writes.length) return;
      const statements = writes.map((write) =>
        d1.prepare(write.sql).bind(...normaliseParams(write.params, write.sql)),
      );
      await d1.batch(statements);
    },
  };
}
