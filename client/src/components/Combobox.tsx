import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export interface ComboOption {
  value: string;
  label: string;
  sublabel?: string | null;
}

/**
 * A dropdown you can also type into. Click (or press ↓) to see every option
 * like a normal select; type to narrow the list. Used wherever someone picks
 * from a long list of people or organizations.
 *
 * Accessible as an ARIA combobox: ↑/↓ move, Enter selects, Escape closes,
 * and the highlighted option is announced via aria-activedescendant.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Search...',
  emptyOption,
  ariaLabel,
  invalid,
  disabled,
  id,
}: {
  options: readonly ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** An extra first choice such as "Any contact" or "No organization" (value ''). */
  emptyOption?: ComboOption;
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const generated = useId();
  const inputId = id ?? `combo-${generated}`;
  const listId = `${inputId}-list`;
  const all = useMemo(() => (emptyOption ? [emptyOption, ...options] : [...options]), [options, emptyOption]);
  const selected = all.find((o) => o.value === value) ?? null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? all.filter(
            (o) => o.label.toLowerCase().includes(q) || (o.sublabel ?? '').toLowerCase().includes(q),
          )
        : all,
    [all, q],
  );

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, filtered.findIndex((o) => o.value === value));
    setActive(q ? 0 : index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(option: ComboOption | undefined) {
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      if (open) {
        event.preventDefault();
        choose(filtered[active]);
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setQuery('');
      }
    } else if (event.key === 'Tab') {
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : (selected?.label ?? '')}
        placeholder={open ? (selected?.label ?? placeholder) : placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() =>
          // Let an option click land before closing.
          window.setTimeout(() => {
            setOpen(false);
            setQuery('');
          }, 120)
        }
        onKeyDown={onKeyDown}
        className={`input pr-9 ${invalid ? 'input-error' : ''}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setOpen((v) => !v);
          inputRef.current?.focus();
        }}
        className="absolute inset-y-0 right-0 grid w-9 place-items-center text-slate-400"
      >
        ▾
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-raised"
        >
          {filtered.length === 0 && <li className="px-3 py-2 text-slate-500">No matches</li>}
          {filtered.map((option, index) => (
            <li
              key={`${option.value}-${index}`}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              onMouseEnter={() => setActive(index)}
              className={`flex min-h-[40px] cursor-pointer items-center gap-2 px-3 ${
                index === active ? 'bg-teal-50 text-teal-800' : 'text-slate-700'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">
                {option.label}
                {option.sublabel && <span className="text-slate-400"> — {option.sublabel}</span>}
              </span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
