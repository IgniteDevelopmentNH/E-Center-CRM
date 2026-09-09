/** Values accepted as bound SQL parameters. Booleans are stored as INTEGER 0/1. */
export type SqlParam = string | number | null;

export type Row = Record<string, unknown>;

/**
 * The whole application talks to the database through this interface. It is
 * implemented once for real D1 (db/d1.ts) and once more, with the identical
 * shape, for the local-dev/test shim (dev/fakeD1.mjs) -- so route code never
 * needs to know which one it is talking to.
 *
 * D1 has no interactive `BEGIN ... COMMIT` transactions the way a persistent
 * Postgres/SQLite connection does; it only offers `batch()` over a fixed list
 * of already-prepared statements. So there is no generic `tx(fn)` here: a
 * handler that needs atomicity decides all its branching in plain JS first
 * (reads happen before this is called), then hands the resulting writes to
 * `batch()` in one shot.
 */
export interface Db {
  all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  run(sql: string, params?: SqlParam[]): Promise<void>;
  /** Executes every write atomically. Each entry is independent -- no branching between them. */
  batch(writes: { sql: string; params?: SqlParam[] }[]): Promise<void>;
}

/**
 * node:sqlite rejects `undefined`, and D1 would likely coerce it to NULL
 * silently. Normalising here means a forgotten optional field fails loudly at
 * the call site instead of writing surprising data.
 */
export function normaliseParams(params: SqlParam[] | undefined, sql: string): SqlParam[] {
  if (!params) return [];
  return params.map((value, i) => {
    if (value === undefined) {
      throw new Error(`Parameter ${i + 1} is undefined for SQL: ${sql}`);
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}
