import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { initials } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import type { AccountType, InterestTag, PublicMember } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';

/* Shared building blocks for the community portal. Built from the CRM's own
   tokens and component classes (card, btn-*, chip, input, label) so the two
   interfaces read as one product. */

export function accountTypeLabel(type: AccountType | string): string {
  if (type === 'student') return 'Student';
  if (type === 'mentor') return 'Mentor';
  if (type === 'staff') return 'ECenter staff';
  return type;
}

const AVATAR_SIZES = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-12 w-12 text-sm',
  lg: 'h-16 w-16 text-lg',
  xl: 'h-24 w-24 text-2xl',
} as const;

/** Profile photo when there is one, otherwise teal initials. Decorative: the name is always shown beside it. */
export function MemberAvatar({
  name,
  photoUrl,
  size = 'md',
}: {
  name: string;
  photoUrl: string | null;
  size?: keyof typeof AVATAR_SIZES;
}) {
  const [failed, setFailed] = useState(false);
  if (photoUrl && !failed) {
    return (
      <img
        src={photoUrl}
        alt=""
        onError={() => setFailed(true)}
        className={`${AVATAR_SIZES[size]} shrink-0 rounded-full object-cover ring-2 ring-white`}
      />
    );
  }
  return (
    <span
      className={`${AVATAR_SIZES[size]} grid shrink-0 place-items-center rounded-full bg-teal font-bold text-white ring-2 ring-white`}
      aria-hidden="true"
    >
      {initials(name) || '?'}
    </span>
  );
}

export function TypeBadge({ type }: { type: AccountType }) {
  const tone =
    type === 'mentor' ? 'bg-teal-50 text-teal-800' : type === 'staff' ? 'bg-navy-50 text-navy-700' : 'bg-slate-100 text-slate-600';
  return <span className={`chip ${tone}`}>{accountTypeLabel(type)}</span>;
}

/** Read-only public interest/expertise tags, optionally truncated. */
export function TopicChips({ tags, max }: { tags: InterestTag[]; max?: number }) {
  if (!tags.length) return null;
  const shown = max ? tags.slice(0, max) : tags;
  const hidden = tags.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Topics">
      {shown.map((tag) => (
        <li key={tag.slug} className="chip bg-teal-50 text-teal-800">
          {tag.label}
        </li>
      ))}
      {hidden > 0 && <li className="chip bg-slate-100 text-slate-500">+{hidden} more</li>}
    </ul>
  );
}

/** The shared public taxonomy (never CRM tags). */
export function useInterestTags() {
  const { data, loading, error } = useApi<{ tags: InterestTag[] }>('/community/tags');
  return { tags: data?.tags ?? [], loading, error };
}

/** Searchable multi-select over the shared taxonomy. Keyboard: tab to a topic, Space/Enter toggles. */
export function TopicPicker({
  label,
  hint,
  value,
  onChange,
  max = 10,
  idPrefix,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (slugs: string[]) => void;
  max?: number;
  idPrefix: string;
}) {
  const { tags, loading, error } = useInterestTags();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const q = query.trim().toLowerCase();
  const hiddenCount = tags.filter((tag) => tag.featured === false).length;
  // Featured topics first; the rest appear after "See more" (or when searching,
  // or when already selected).
  const filtered = q
    ? tags.filter((tag) => tag.label.toLowerCase().includes(q))
    : showAll
      ? tags
      : tags.filter((tag) => tag.featured !== false || value.includes(tag.slug));
  const atMax = value.length >= max;

  const toggle = (slug: string) =>
    onChange(value.includes(slug) ? value.filter((s) => s !== slug) : atMax ? value : [...value, slug]);

  return (
    <fieldset>
      <legend className="label">{label}</legend>
      {hint && <p className="-mt-1 mb-2 text-xs text-slate-500">{hint}</p>}
      {tags.length > 8 && (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search topics"
          aria-label={`Search ${label.toLowerCase()}`}
          className="input mb-2"
          id={`${idPrefix}-search`}
        />
      )}
      {loading && <p className="text-sm text-slate-500">Loading topics...</p>}
      {error && <p className="text-sm text-urgent">Topics could not be loaded.</p>}
      <div className="flex flex-wrap gap-2">
        {filtered.map((tag) => {
          const selected = value.includes(tag.slug);
          return (
            <button
              key={tag.slug}
              type="button"
              onClick={() => toggle(tag.slug)}
              aria-pressed={selected}
              disabled={!selected && atMax}
              className={`chip min-h-[36px] border px-3 transition disabled:opacity-40 ${
                selected ? 'border-teal bg-teal text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-teal-200'
              }`}
            >
              {selected && <span aria-hidden="true">✓</span>}
              {tag.label}
            </button>
          );
        })}
        {!q && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="chip min-h-[36px] border border-dashed border-navy-200 bg-navy-50 px-3 font-semibold text-navy-700 transition hover:bg-navy-100"
          >
            {showAll ? 'See fewer' : `See more (${hiddenCount})`}
          </button>
        )}
        {!loading && filtered.length === 0 && <p className="text-sm text-slate-500">No topics match that.</p>}
      </div>
      <p className="mt-1.5 text-xs text-slate-500" aria-live="polite">
        {value.length} of {max} selected
      </p>
    </fieldset>
  );
}

/** Compact, keyboard-accessible single-select filter over the taxonomy. */
export function TopicFilter({ value, onChange }: { value: string; onChange: (slug: string) => void }) {
  const { tags } = useInterestTags();
  const [expanded, setExpanded] = useState(false);
  const featured = tags.filter((tag) => tag.featured !== false);
  const preview = featured.slice(0, 8);
  // Keep a selected topic visible even when the list is collapsed.
  const selected = tags.find((tag) => tag.slug === value);
  const visible = expanded ? tags : selected && !preview.includes(selected) ? [...preview, selected] : preview;
  const chip = (slug: string, text: string) => (
    <button
      key={slug}
      type="button"
      onClick={() => onChange(slug)}
      aria-pressed={value === slug}
      className={`chip min-h-[32px] border px-3 transition ${
        value === slug ? 'border-teal bg-teal text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-teal-200'
      }`}
    >
      {text}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by topic">
      {chip('all', 'All topics')}
      {visible.map((tag) => chip(tag.slug, tag.label))}
      {tags.length > preview.length && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="chip min-h-[32px] border border-dashed border-navy-200 bg-navy-50 px-3 font-semibold text-navy-700 transition hover:bg-navy-100"
        >
          {expanded ? 'See fewer' : 'See more'}
        </button>
      )}
    </div>
  );
}

function subtitleFor(member: PublicMember): string | null {
  if (member.accountType === 'student') {
    const parts = [member.major, member.graduationYear ? `Class of ${member.graduationYear}` : null].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  const parts = [member.roleTitle, member.company].filter(Boolean);
  return parts.length ? parts.join(' at ') : null;
}

export { subtitleFor };

/** Message + meeting actions shared by mentor cards and profiles. Never claims a meeting is booked. */
export function MemberActions({ member, compact }: { member: PublicMember; compact?: boolean }) {
  const navigate = useNavigate();
  const { user, isActiveMember } = useAuth();
  if (!member.available || member.id === user?.id) return null;

  const size = compact ? 'min-h-[40px] px-3' : '';
  if (!isActiveMember) {
    return (
      <p className="text-xs text-slate-500">
        <Link to="/profile" className="font-semibold text-teal-700 hover:underline">
          Create your community profile
        </Link>{' '}
        to message members.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={`btn-ghost ${size}`} onClick={() => navigate(`/messages?to=${member.id}`)}>
        Message
      </button>
      {member.accountType === 'mentor' &&
        (member.schedulingUrl ? (
          <a
            href={member.schedulingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`btn-secondary ${size}`}
            aria-label={`Book a meeting with ${member.firstName} (opens their scheduling page in a new tab)`}
          >
            Book a meeting <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <button
            type="button"
            className={`btn-secondary ${size}`}
            onClick={() => navigate(`/messages?to=${member.id}&meeting=1`)}
          >
            Request a meeting
          </button>
        ))}
    </div>
  );
}

/** Directory card (Network). The whole header links to the profile. */
export function MemberCard({ member, footer }: { member: PublicMember; footer?: ReactNode }) {
  const subtitle = subtitleFor(member);
  return (
    <article className="card flex h-full flex-col p-5">
      <Link to={`/members/${member.id}`} className="group flex items-start gap-3 rounded-lg focus-visible:ring-offset-4">
        <MemberAvatar name={member.fullName} photoUrl={member.photoUrl} />
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-navy-800 group-hover:underline">{member.fullName}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <TypeBadge type={member.accountType} />
          </div>
          {subtitle && <p className="mt-1 truncate text-xs text-slate-500">{subtitle}</p>}
        </div>
      </Link>
      {member.bio && <p className="mt-3 line-clamp-2 text-sm text-slate-600">{member.bio}</p>}
      <div className="mt-3 flex-1">
        <TopicChips tags={dedupeTopics(member)} max={4} />
      </div>
      {footer && <div className="mt-4">{footer}</div>}
    </article>
  );
}

/** Mentor card: teal top accent, photo/initials, role, short bio, expertise, actions. */
export function MentorCard({ member, reason }: { member: PublicMember; reason?: string | null }) {
  const subtitle = subtitleFor(member);
  return (
    <article className="card flex h-full flex-col overflow-hidden">
      <div className="h-1.5 bg-teal" aria-hidden="true" />
      <div className="flex flex-1 flex-col p-5">
        <Link to={`/members/${member.id}`} className="group flex items-center gap-3 rounded-lg">
          <MemberAvatar name={member.fullName} photoUrl={member.photoUrl} size="lg" />
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-navy-800 group-hover:underline">{member.fullName}</h3>
            {subtitle && <p className="truncate text-sm text-slate-500">{subtitle}</p>}
          </div>
        </Link>
        {reason && (
          <p className="mt-3 rounded-lg bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800">{reason}</p>
        )}
        {member.bio && <p className="mt-3 line-clamp-3 text-sm text-slate-600">{member.bio}</p>}
        <div className="mt-3 flex-1">
          <TopicChips tags={dedupeTopics(member)} max={5} />
        </div>
        <div className="mt-4 border-t border-slate-100 pt-4">
          <MemberActions member={member} compact />
        </div>
      </div>
    </article>
  );
}

/** Interests and help topics combined for compact display, without repeats. */
export function dedupeTopics(member: { interests: InterestTag[]; help: InterestTag[] }): InterestTag[] {
  const seen = new Map<string, InterestTag>();
  for (const tag of [...member.help, ...member.interests]) seen.set(tag.slug, tag);
  return [...seen.values()];
}

/** Navy-to-teal branded panel used on the signup and landing screens. */
export function BrandPanel({ compact }: { compact?: boolean }) {
  const benefits = useMemo(
    () => [
      { title: 'Connect with mentors', text: 'Find alumni and professionals who have been where you are going.' },
      { title: 'Discover opportunities', text: 'Hear about ECenter events, programs and news first.' },
      { title: 'Build your network', text: 'Meet students and mentors who share your interests.' },
    ],
    [],
  );
  return (
    <div className="relative h-full overflow-hidden bg-gradient-to-br from-navy-800 via-navy to-teal-700 text-white">
      {/* Subtle geometric decoration. */}
      <svg className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 opacity-10" viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="98" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="100" cy="100" r="66" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="100" cy="100" r="34" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <svg className="pointer-events-none absolute -bottom-16 -left-16 h-64 w-64 opacity-10" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M0 100 L50 0 L100 100 Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>

      <div className={`relative flex h-full flex-col ${compact ? 'px-5 py-6' : 'px-10 py-12 lg:px-14'}`}>
        <Link to="/" className="flex items-center gap-3" aria-label="UNH ECenter community home">
          <img src="/unh-logo.svg" alt="University of New Hampshire" className={compact ? 'h-7 w-auto' : 'h-10 w-auto'} />
          <span className="h-7 w-px bg-white/30" aria-hidden="true" />
          <span className="font-bold">ECenter</span>
        </Link>
        <h1 className={`font-bold leading-tight ${compact ? 'mt-4 text-xl' : 'mt-16 text-4xl'}`}>
          Where students and mentors grow together
        </h1>
        {!compact && (
          <ul className="mt-10 space-y-6">
            {benefits.map((benefit) => (
              <li key={benefit.title} className="flex gap-4">
                <span className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/15 text-sm" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <span className="block font-semibold">{benefit.title}</span>
                  <span className="block text-sm text-navy-100">{benefit.text}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {compact && <p className="mt-1 text-sm text-navy-100">Connect with mentors, discover opportunities and build your network.</p>}
        {!compact && (
          <p className="mt-auto pt-12 text-xs text-navy-100">University of New Hampshire Entrepreneurship Center</p>
        )}
      </div>
    </div>
  );
}

/** Two-column (desktop) / stacked (mobile) frame for the public auth screens. */
export function AuthSplitLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="lg:hidden">
        <BrandPanel compact />
      </div>
      <div className="hidden lg:block">
        <BrandPanel />
      </div>
      <main className="flex items-start justify-center px-4 py-8 sm:px-8 lg:items-center lg:py-12">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  );
}
