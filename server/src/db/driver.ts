/** Values accepted as bound SQL parameters. Booleans are stored as INTEGER 0/1. */
export type SqlParam = string | number | null;

export type Dialect = 'sqlite' | 'postgres';

/**
 * The whole application talks to the database through this interface, using
 * `?` placeholders and the portable SQL subset described in schema.sql. The
 * PostgreSQL driver rewrites placeholders to `$1..$n`.
 */
export interface Db {
  readonly dialect: Dialect;
  all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  run(sql: string, params?: SqlParam[]): Promise<void>;
  /** Multi-statement DDL. Not parameterised. */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back on any thrown error. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type Row = Record<string, unknown>;

/** Rewrites portable `?` placeholders into PostgreSQL `$1..$n` positional ones. */
export function toPositional(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/**
 * node:sqlite rejects `undefined`, and Postgres would coerce it to NULL silently.
 * Normalising here means a forgotten optional field fails loudly at the call site
 * instead of writing surprising data.
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
