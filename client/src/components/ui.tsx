import type { ChangeEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useState } from 'react';
import { humanise } from '../lib/format.ts';

/* ---------------------------------------------------------------- feedback -- */

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="grid place-items-center py-12">
      <Spinner label={label} />
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card border-urgent/30 bg-red-50 p-6 text-center">
      <p className="text-sm font-semibold text-urgent">{message}</p>
      {onRetry && (
        <button type="button" className="btn-ghost mt-3" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
  icon = '◇',
}: {
  title: string;
  message: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="card border-dashed p-10 text-center">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-navy-50 text-xl text-navy-600" aria-hidden="true">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-navy-800">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ chips -- */

const TONE_STYLES = {
  navy: 'bg-navy-50 text-navy-700',
  teal: 'bg-teal-50 text-teal-800',
  gold: 'bg-gold-100 text-gold-600',
  green: 'bg-green-50 text-success',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-urgent',
  slate: 'bg-slate-100 text-slate-600',
} as const;

export type Tone = keyof typeof TONE_STYLES;

export function Chip({ children, tone = 'slate' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`chip ${TONE_STYLES[tone]}`}>{children}</span>;
}

/** Colour-coded relationship tags. Founder-related tags carry the accent. */
export function TagChip({ tag }: { tag: string }) {
  const tone: Tone =
    tag === 'Student Founder'
      ? 'gold'
      : tag === 'Founder'
        ? 'teal'
        : tag === 'Mentor'
          ? 'navy'
          : tag === 'Investor' || tag === 'Sponsor'
            ? 'green'
            : 'slate';
  return <Chip tone={tone}>{tag}</Chip>;
}

export const CONTACT_STATUS_TONES: Record<string, Tone> = {
  active: 'green',
  past: 'slate',
  on_hold: 'amber',
};

export const ORG_TYPE_TONES: Record<string, Tone> = {
  startup: 'teal',
  established: 'navy',
  club: 'teal',
  nonprofit: 'green',
  other: 'slate',
};

export const TASK_STATUS_TONES: Record<string, Tone> = {
  overdue: 'red',
  open: 'navy',
  in_progress: 'amber',
  complete: 'green',
};

export const PRIORITY_TONES: Record<string, Tone> = { high: 'red', medium: 'amber', low: 'slate' };

export const EVENT_TYPE_TONES: Record<string, Tone> = {
  workshop: 'teal',
  speaker_series: 'navy',
  ideathon: 'gold',
  networking: 'green',
  one_on_one: 'slate',
  other: 'slate',
};

export function StatusChip({ value, tones }: { value: string; tones: Record<string, Tone> }) {
  return <Chip tone={tones[value] ?? 'slate'}>{humanise(value)}</Chip>;
}

/* ------------------------------------------------------------------ forms -- */

export function Field({
  label,
  children,
  error,
  hint,
  required,
}: {
  label: string;
  children: ReactNode;
  error?: string | null;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required && <span className="ml-0.5 text-urgent">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-semibold text-urgent">{error}</span>}
    </label>
  );
}

export function TextInput({ invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...props} className={`input ${invalid ? 'input-error' : ''}`} />;
}

export function TextArea({
  invalid,
  rows = 4,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...props} rows={rows} className={`input resize-y ${invalid ? 'input-error' : ''}`} />;
}

export function Select({
  options,
  includeAll,
  allLabel = 'All',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  options: readonly string[] | readonly { value: string; label: string }[];
  includeAll?: boolean;
  allLabel?: string;
}) {
  const normalised = options.map((option) =>
    typeof option === 'string' ? { value: option, label: humanise(option) } : option,
  );
  return (
    <select {...props} className="input pr-8">
      {includeAll && <option value="all">{allLabel}</option>}
      {normalised.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-teal focus:ring-teal"
      />
      {label}
    </label>
  );
}

export function RadioGroup({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {options.map((option) => (
        <label
          key={option}
          className={`chip min-h-[36px] cursor-pointer border px-3 ${
            value === option
              ? 'border-navy bg-navy text-white'
              : 'border-slate-300 bg-white text-slate-600 hover:border-navy-200'
          }`}
        >
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
            className="sr-only"
          />
          {humanise(option)}
        </label>
      ))}
    </div>
  );
}

/** Multi-select over a fixed list, plus free-text entry for custom tags. */
export function TagPicker({
  value,
  onChange,
  suggestions,
  allowCustom = true,
  placeholder = 'Add a tag and press Enter',
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: readonly string[];
  allowCustom?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const toggle = (tag: string) =>
    onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);

  const commitDraft = () => {
    const tag = draft.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft('');
  };

  const custom = value.filter((tag) => !suggestions.includes(tag));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {suggestions.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => toggle(tag)}
            aria-pressed={value.includes(tag)}
            className={`chip min-h-[32px] border px-3 transition ${
              value.includes(tag)
                ? 'border-teal bg-teal text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:border-teal-200'
            }`}
          >
            {tag}
          </button>
        ))}
      </div>

      {custom.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {custom.map((tag) => (
            <span key={tag} className="chip bg-navy-50 text-navy-700">
              {tag}
              <button
                type="button"
                onClick={() => toggle(tag)}
                className="ml-0.5 text-navy-600 hover:text-urgent"
                aria-label={`Remove ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {allowCustom && (
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commitDraft();
            }
          }}
          onBlur={commitDraft}
          className="input"
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- layout -- */

export function SectionHeader({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-navy-800">
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  detail,
  tone = 'navy',
  onClick,
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: 'navy' | 'teal' | 'amber' | 'red';
  onClick?: () => void;
}) {
  const accents = {
    navy: 'text-navy',
    teal: 'text-teal',
    amber: 'text-amber-600',
    red: 'text-urgent',
  } as const;

  const content = (
    <>
      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${accents[tone]}`}>{value}</p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="card-interactive p-4 text-left">
        {content}
      </button>
    );
  }
  return <div className="card p-4">{content}</div>;
}

export function Pagination({
  page,
  limit,
  total,
  onPageChange,
}: {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total === 0) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-slate-500">
        Showing <span className="font-semibold text-slate-700">{from}</span>-
        <span className="font-semibold text-slate-700">{to}</span> of{' '}
        <span className="font-semibold text-slate-700">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-ghost"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span className="text-sm text-slate-500">
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className="btn-ghost"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function Avatar({ name, tone = 'navy' }: { name: string; tone?: 'navy' | 'teal' }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold text-white ${
        tone === 'navy' ? 'bg-navy' : 'bg-teal'
      }`}
      aria-hidden="true"
    >
      {letters || '?'}
    </span>
  );
}
