/**
 * All persisted timestamps are ISO-8601 UTC strings and all persisted dates are
 * `YYYY-MM-DD`. Both forms sort lexicographically, which is what lets the
 * portable query layer compare them with plain SQL operators.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

/** Today in `YYYY-MM-DD`, in the server timezone. */
export function todayDate(): string {
  return toDateOnly(new Date());
}

export function toDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDaysToDate(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  return toDateOnly(date);
}

export function addMonthsToDate(dateOnly: string, months: number): string {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const targetMonth = date.getMonth() + months;
  date.setMonth(targetMonth);
  // Clamp overflow, so 31 Jan + 1 month lands on 28/29 Feb rather than early March.
  if (date.getMonth() !== ((targetMonth % 12) + 12) % 12) date.setDate(0);
  return toDateOnly(date);
}

/** ISO timestamp `n` days from now -- used for "next 7 / 30 days" windows. */
export function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Human date used in generated note text, e.g. "Jan 15, 2025". */
export function formatDisplayDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function daysAgoIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}
