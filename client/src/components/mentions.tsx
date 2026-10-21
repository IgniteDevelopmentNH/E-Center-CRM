import { Fragment, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { api, buildQuery } from '../lib/api.ts';
import type { MembersResponse, PublicMember } from '../lib/types.ts';
import { MemberAvatar, accountTypeLabel } from './community.tsx';

/**
 * @mentions. Stored text carries `@[Display Name](user:<id>)` tokens (the
 * server re-validates every one). In the editor people see plain
 * "@Display Name"; this module converts both ways.
 */

const TOKEN_RE = /@\[([^\]\n]{1,80})\]\(user:([0-9a-f-]{36})\)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stored -> editor text, plus the name -> id map the editor needs to convert back. */
export function storedToDisplay(stored: string): { text: string; map: Map<string, string> } {
  const map = new Map<string, string>();
  const text = stored.replace(TOKEN_RE, (_whole, name: string, id: string) => {
    map.set(name, id);
    return `@${name}`;
  });
  return { text, map };
}

/** Editor text -> stored, turning each known "@Name" back into a token. */
export function displayToStored(text: string, map: Map<string, string>): string {
  let out = text;
  // Longest names first, so "@Ana Ruiz Lopez" wins over "@Ana Ruiz".
  for (const [name, id] of [...map.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`@${escapeRegExp(name)}(?![\\w])`, 'g'), `@[${name}](user:${id})`);
  }
  return out;
}

/** Plain text with mentions shown as "@Name" (for previews). */
export function plainText(stored: string): string {
  return stored.replace(TOKEN_RE, (_whole, name: string) => `@${name}`);
}

/** Renders stored text: paragraphs, line breaks, and @mentions linked to profiles. */
export function RichText({
  text,
  className = '',
  linkMentions = true,
}: {
  text: string;
  className?: string;
  linkMentions?: boolean;
}) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <div className={`space-y-3 ${className}`}>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line break-words">
          {renderMentions(paragraph, linkMentions)}
        </p>
      ))}
    </div>
  );
}

function renderMentions(text: string, link: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(<Fragment key={`t${last}`}>{text.slice(last, start)}</Fragment>);
    const [, name, id] = match;
    nodes.push(
      link ? (
        <Link key={`m${start}`} to={`/members/${id}`} className="font-semibold text-teal-700 hover:underline">
          @{name}
        </Link>
      ) : (
        <span key={`m${start}`} className="font-semibold text-teal-700">
          @{name}
        </span>
      ),
    );
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return nodes;
}

/**
 * A textarea with @mention autocomplete. `value`/`onChange` use the STORED
 * format, so callers just send `value` to the API.
 */
export function MentionTextarea({
  value,
  onChange,
  rows = 4,
  placeholder,
  invalid,
  id,
  maxLength,
  ...rest
}: {
  value: string;
  onChange: (stored: string) => void;
  invalid?: boolean;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const initial = useRef(storedToDisplay(value));
  const [display, setDisplay] = useState(initial.current.text);
  const mapRef = useRef(initial.current.map);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ text: string; start: number } | null>(null);
  const [results, setResults] = useState<PublicMember[]>([]);
  const [active, setActive] = useState(0);
  const lastEmitted = useRef(value);

  // A parent reset (e.g. clearing after send) re-seeds the editor.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      const next = storedToDisplay(value);
      mapRef.current = next.map;
      setDisplay(next.text);
      lastEmitted.current = value;
    }
  }, [value]);

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .get<MembersResponse>(`/community/members${buildQuery({ q: query.text, limit: 6 })}`)
        .then((response) => {
          if (!cancelled) {
            setResults(response.members);
            setActive(0);
          }
        })
        .catch(() => !cancelled && setResults([]));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  function emit(text: string) {
    setDisplay(text);
    const stored = displayToStored(text, mapRef.current);
    lastEmitted.current = stored;
    onChange(stored);
  }

  function detect(text: string, caret: number) {
    const before = text.slice(0, caret);
    const match = /(^|\s)@([A-Za-z][\w.'-]{0,30})$/.exec(before);
    setQuery(match ? { text: match[2]!, start: caret - match[2]!.length - 1 } : null);
  }

  function pick(member: PublicMember) {
    const el = textareaRef.current;
    if (!el || !query) return;
    const caret = el.selectionStart;
    const name = member.fullName;
    mapRef.current.set(name, member.id);
    const next = `${display.slice(0, query.start)}@${name} ${display.slice(caret)}`;
    emit(next);
    setQuery(null);
    const position = query.start + name.length + 2;
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(position, position);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (query && results.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => Math.min(results.length - 1, i + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(results[active]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setQuery(null);
        return;
      }
    }
    rest.onKeyDown?.(event);
  }

  const listId = `${id ?? 'mention'}-suggestions`;
  return (
    <div className="relative">
      <textarea
        {...rest}
        id={id}
        ref={textareaRef}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        value={display}
        onChange={(event) => {
          emit(event.target.value);
          detect(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => detect(event.currentTarget.value, event.currentTarget.selectionStart)}
        onBlur={(event) => {
          window.setTimeout(() => setQuery(null), 150);
          rest.onBlur?.(event);
        }}
        aria-autocomplete="list"
        aria-controls={query && results.length ? listId : undefined}
        aria-activedescendant={query && results.length ? `${listId}-${active}` : undefined}
        className={`input resize-y ${invalid ? 'input-error' : ''}`}
      />
      {query && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Mention a member"
          className="absolute left-0 right-0 z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-raised"
        >
          {results.map((member, index) => (
            <li
              key={member.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(member)}
              onMouseEnter={() => setActive(index)}
              className={`flex min-h-[44px] cursor-pointer items-center gap-2 px-3 text-sm ${
                index === active ? 'bg-teal-50' : ''
              }`}
            >
              <MemberAvatar name={member.fullName} photoUrl={member.photoUrl} size="sm" />
              <span className="min-w-0">
                <span className="block truncate font-semibold text-navy-800">{member.fullName}</span>
                <span className="block text-xs text-slate-500">{accountTypeLabel(member.accountType)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] text-slate-400">Type @ to mention someone.</p>
    </div>
  );
}
