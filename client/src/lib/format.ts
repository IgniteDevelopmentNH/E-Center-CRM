const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jan 15, 2025" */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '--';
  const date = parse(value);
  if (!date) return '--';
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** "Jan 15, 2025 at 2:30 PM" -- the note timestamp format. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '--';
  const date = parse(value);
  if (!date) return '--';
  return `${formatDate(value)} at ${formatTime(date)}`;
}

export function formatTime(input: string | Date): string {
  const date = typeof input === 'string' ? parse(input) : input;
  if (!date) return '--';
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

/** "3 days ago", "in 2 weeks" -- used on cards where precision is not the point. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'No interactions yet';
  const date = parse(value);
  if (!date) return 'No interactions yet';

  const diffMs = date.getTime() - Date.now();
  const past = diffMs < 0;
  const days = Math.floor(Math.abs(diffMs) / 86_400_000);

  if (days === 0) return past ? 'Today' : 'Today';
  if (days === 1) return past ? 'Yesterday' : 'Tomorrow';
  if (days < 7) return past ? `${days} days ago` : `In ${days} days`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return past ? `${weeks} week${weeks > 1 ? 's' : ''} ago` : `In ${weeks} week${weeks > 1 ? 's' : ''}`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return past ? `${months} month${months > 1 ? 's' : ''} ago` : `In ${months} month${months > 1 ? 's' : ''}`;
  }
  const years = Math.floor(days / 365);
  return past ? `${years} year${years > 1 ? 's' : ''} ago` : `In ${years} year${years > 1 ? 's' : ''}`;
}

/** Days until a `YYYY-MM-DD` due date; negative means overdue. */
export function daysUntil(dateOnly: string): number {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const due = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

export function dueLabel(dateOnly: string): string {
  const days = daysUntil(dateOnly);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return '1 day overdue';
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days < 7) return `Due in ${days} days`;
  return `Due ${formatDate(`${dateOnly}T12:00:00`)}`;
}

/** `YYYY-MM-DD` for today, in the browser timezone. */
export function todayInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** ISO timestamp to the value a `datetime-local` input expects. */
export function toDateTimeInput(iso: string | null): string {
  if (!iso) return '';
  const date = parse(iso);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}...`;
}

/** Turns snake_case enum values into display text. */
export function humanise(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parse(value: string): Date | null {
  // Bare `YYYY-MM-DD` parses as UTC midnight, which can display as the previous
  // day in western timezones. Anchor it to local noon instead.
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}
