/**
 * A local stand-in for a Cloudflare D1 binding, backed by node:sqlite.
 *
 * Implements the same surface worker/src/db/d1.ts calls (`prepare().bind().all()
 * /.first()/.run()` and `.batch()`), so worker/src/db/d1.ts itself runs
 * completely unmodified against this in dev/tests -- only the object passed in
 * as `env.DB` differs from production. `wrangler dev`'s bundled `workerd` has
 * no win32-arm64 build, so this is how local iteration works on this machine.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function createFakeD1(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = new DatabaseSync(filePath);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');

  function prepare(sql) {
    let bound = [];
    const statement = {
      bind(...args) {
        bound = args;
        return statement;
      },
      async first(colName) {
        const row = handle.prepare(sql).get(...bound);
        if (row === undefined) return null;
        const plain = { ...row };
        return colName ? (plain[colName] ?? null) : plain;
      },
      async run() {
        const info = handle.prepare(sql).run(...bound);
        return {
          success: true,
          results: [],
          meta: {
            duration: 0,
            last_row_id: Number(info.lastInsertRowid ?? 0),
            changes: Number(info.changes ?? 0),
          },
        };
      },
      async all() {
        const rows = handle.prepare(sql).all(...bound);
        return { success: true, results: rows.map((row) => ({ ...row })), meta: { duration: 0 } };
      },
    };
    return statement;
  }

  return {
    prepare,
    async batch(statements) {
      handle.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        handle.exec('COMMIT');
        return results;
      } catch (error) {
        handle.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) {
      handle.exec(sql);
      return { count: 0, duration: 0 };
    },
    /** Dev/test-only escape hatch -- not part of the real D1Database interface. */
    _raw: handle,
    _close() {
      handle.close();
    },
  };
}
