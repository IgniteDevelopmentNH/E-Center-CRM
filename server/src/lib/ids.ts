import crypto from 'node:crypto';

/** Application-generated primary key. Portable across SQLite and Postgres. */
export function newId(): string {
  return crypto.randomUUID();
}
