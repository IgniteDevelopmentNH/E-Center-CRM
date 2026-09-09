/** Application-generated primary key. `crypto.randomUUID()` is a Web API global -- no import needed. */
export function newId(): string {
  return crypto.randomUUID();
}
