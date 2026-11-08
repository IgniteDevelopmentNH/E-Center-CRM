import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, downloadCsv } from '../lib/api.ts';
import { EVENT_ICONS, EVENT_ICON_MAP } from '../lib/eventIcons.ts';
import { useApi } from '../lib/hooks.ts';
import type { Attendee, CommunityGroup, EventResponses, QuestionType, RegistrationQuestion } from '../lib/types.ts';
import { useToast } from '../state/ToastContext.tsx';
import { MemberAvatar, accountTypeLabel } from './community.tsx';
import { Modal } from './overlays.tsx';
import { Checkbox, Spinner, TextInput } from './ui.tsx';

/**
 * Options shared by member events, staff events and CRM events: who can RSVP,
 * 21+, a public attendee list, the icon palette, registration questions,
 * hiding from guests, and sharing only with chosen groups.
 */

export type RsvpMode = 'off' | 'accounts' | 'everyone';

export interface DraftQuestion extends Omit<RegistrationQuestion, 'id'> {
  id?: string;
  key: number;
}

export interface EventOptionsValue {
  rsvpMode: RsvpMode;
  age21: boolean;
  attendeesPublic: boolean;
  icons: string[];
  questions: DraftQuestion[];
}

let nextQuestionKey = 1;

const draftQuestion = (question: Partial<DraftQuestion> = {}): DraftQuestion => ({
  type: 'yesno',
  label: '',
  required: true,
  options: [],
  ...question,
  key: nextQuestionKey++,
});

export function eventOptionsFrom(source?: {
  rsvpEnabled: boolean;
  guestRsvp: boolean;
  age21: boolean;
  attendeesPublic: boolean;
  icons: string[];
  questions: RegistrationQuestion[];
} | null): EventOptionsValue {
  return {
    rsvpMode: !source ? 'accounts' : !source.rsvpEnabled ? 'off' : source.guestRsvp ? 'everyone' : 'accounts',
    age21: source?.age21 ?? false,
    attendeesPublic: source?.attendeesPublic ?? false,
    icons: source?.icons ?? [],
    questions: (source?.questions ?? []).map((question) => draftQuestion(question)),
  };
}

export const questionsPayload = (questions: DraftQuestion[]) =>
  questions.map(({ id, type, label, required, options }) => ({ id, type, label, required, options }));

const RSVP_MODES: { value: RsvpMode; label: string; hint: string }[] = [
  { value: 'off', label: 'No RSVP', hint: 'People just see the event.' },
  { value: 'accounts', label: 'Account holders', hint: 'People with an account can say "I\'ll be there!"' },
  { value: 'everyone', label: 'Everyone, including guests', hint: 'Guests RSVP with their name and email.' },
];

const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'yesno', label: 'Yes / No' },
  { value: 'choice', label: 'Pick one' },
  { value: 'checkboxes', label: 'Checkboxes (pick any)' },
  { value: 'text', label: 'Written answer' },
];

const QUESTION_PRESETS: Partial<DraftQuestion>[] = [
  { type: 'yesno', label: 'Are you bringing a plus one?' },
  { type: 'yesno', label: 'Can we take your picture?' },
  { type: 'checkboxes', label: 'Do you have any dietary restrictions?', required: false, options: ['Vegetarian', 'Vegan', 'Gluten free', 'Nut allergy', 'Other'] },
  { type: 'text', label: 'Anything we should know?', required: false },
];

function QuestionsEditor({
  value,
  onChange,
  error,
}: {
  value: DraftQuestion[];
  onChange: (questions: DraftQuestion[]) => void;
  error?: string | null;
}) {
  const update = (key: number, change: Partial<DraftQuestion>) =>
    onChange(value.map((q) => (q.key === key ? { ...q, ...change } : q)));
  const move = (index: number, by: number) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };
  const usesOptions = (type: QuestionType) => type === 'choice' || type === 'checkboxes';

  return (
    <div className="space-y-3">
      <div>
        <p className="label mb-0.5">Registration questions</p>
        <p className="text-xs text-slate-500">Optional. People answer these before their RSVP goes through. Only you and ECenter staff see the answers.</p>
      </div>
      {value.map((question, index) => (
        <div key={question.key} className="space-y-2 rounded-lg border border-slate-200 p-3">
          <TextInput
            value={question.label}
            maxLength={200}
            onChange={(e) => update(question.key, { label: e.target.value })}
            placeholder="Your question"
            aria-label={`Question ${index + 1}`}
          />
          <div className="flex flex-wrap items-center gap-x-3">
            <select
              value={question.type}
              className="input w-auto py-1.5"
              aria-label={`Answer type for question ${index + 1}`}
              onChange={(e) => {
                const type = e.target.value as QuestionType;
                update(question.key, { type, options: usesOptions(type) ? (question.options.length ? question.options : ['', '']) : [] });
              }}
            >
              {QUESTION_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
            <Checkbox label="Required" checked={question.required} onChange={(required) => update(question.key, { required })} />
            <span className="ml-auto flex">
              <button type="button" className="btn-quiet" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">↑</button>
              <button type="button" className="btn-quiet" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label="Move down">↓</button>
              <button type="button" className="btn-quiet text-urgent" onClick={() => onChange(value.filter((q) => q.key !== question.key))}>Remove</button>
            </span>
          </div>
          {usesOptions(question.type) && (
            <div className="space-y-1.5">
              {question.options.map((option, optionIndex) => (
                <div key={optionIndex} className="flex gap-1">
                  <TextInput
                    value={option}
                    maxLength={100}
                    placeholder={`Answer ${optionIndex + 1}`}
                    aria-label={`Answer ${optionIndex + 1}`}
                    onChange={(e) => update(question.key, { options: question.options.map((o, i) => (i === optionIndex ? e.target.value : o)) })}
                  />
                  <button
                    type="button"
                    className="btn-quiet"
                    disabled={question.options.length <= 2}
                    aria-label={`Remove answer ${optionIndex + 1}`}
                    onClick={() => update(question.key, { options: question.options.filter((_, i) => i !== optionIndex) })}
                  >
                    ×
                  </button>
                </div>
              ))}
              {question.options.length < 20 && (
                <button type="button" className="btn-quiet text-teal-700" onClick={() => update(question.key, { options: [...question.options, ''] })}>
                  + Add an answer
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {value.length < 10 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className="btn-ghost min-h-[36px]" onClick={() => onChange([...value, draftQuestion()])}>+ Add a question</button>
          {QUESTION_PRESETS.filter((preset) => !value.some((q) => q.label === preset.label)).map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="chip min-h-[32px] border border-dashed border-slate-300 bg-white px-3 text-slate-600 hover:border-navy-200"
              onClick={() => onChange([...value, draftQuestion(preset)])}
            >
              + {preset.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-xs font-semibold text-urgent">{error}</p>}
    </div>
  );
}

/** The icon palette, grouped, with search. Up to eight per event. */
function IconPicker({ value, onChange, error }: { value: string[]; onChange: (icons: string[]) => void; error?: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = EVENT_ICONS.filter((icon) => !q || icon.label.toLowerCase().includes(q) || icon.group.toLowerCase().includes(q));
  const groups = [...new Set(matches.map((icon) => icon.group))];
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  const full = value.length >= 8;

  return (
    <div>
      <p className="label mb-0.5">Icons</p>
      <p className="mb-2 text-xs text-slate-500">Optional. Show what to expect at a glance, like food or a cash prize. Up to 8.</p>
      {value.length > 0 && <div className="mb-2"><EventIconRow icons={value} /></div>}
      <button type="button" className="btn-ghost min-h-[36px]" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Done choosing' : value.length ? 'Change icons' : 'Choose icons'}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-slate-200 p-3">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search icons" aria-label="Search icons" className="input" />
          {groups.length === 0 && <p className="text-sm text-slate-500">No icons match that.</p>}
          {groups.map((group) => (
            <fieldset key={group}>
              <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{group}</legend>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {matches.filter((icon) => icon.group === group).map(({ key, label, Icon }) => {
                  const selected = value.includes(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selected}
                      disabled={!selected && full}
                      onClick={() => toggle(key)}
                      className={`flex min-h-[40px] items-center gap-2 rounded-lg border px-2.5 text-left text-sm transition disabled:opacity-40 ${
                        selected ? 'border-teal bg-teal-50 font-semibold text-teal-800' : 'border-slate-200 text-slate-700 hover:border-teal-200'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      )}
      {error && <p className="mt-1 text-xs font-semibold text-urgent">{error}</p>}
    </div>
  );
}

/** Everything about an event beyond its name, date and place. */
export function EventOptionsFields({
  value,
  onChange,
  guestVisible,
  errorFor,
}: {
  value: EventOptionsValue;
  onChange: (value: EventOptionsValue) => void;
  /** Guests can only RSVP to events they can see. */
  guestVisible: boolean;
  errorFor: (field: string) => string | null | undefined;
}) {
  const set = (change: Partial<EventOptionsValue>) => onChange({ ...value, ...change });
  const mode = !guestVisible && value.rsvpMode === 'everyone' ? 'accounts' : value.rsvpMode;

  return (
    <div className="space-y-4">
      <IconPicker value={value.icons} onChange={(icons) => set({ icons })} error={errorFor('Icons')} />

      <fieldset>
        <legend className="label">Who can RSVP</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {RSVP_MODES.map((option) => {
            const disabled = option.value === 'everyone' && !guestVisible;
            return (
              <label
                key={option.value}
                className={`rounded-lg border p-2.5 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${mode === option.value ? 'border-navy bg-navy-50' : 'border-slate-200'}`}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-navy-800">
                  <input type="radio" name="rsvp-mode" checked={mode === option.value} disabled={disabled} onChange={() => set({ rsvpMode: option.value })} />
                  {option.label}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">{disabled ? 'Not available while this is hidden from guests.' : option.hint}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <Checkbox label={'21+ event: people confirm "I\'m over 21" when they RSVP'} checked={value.age21} onChange={(age21) => set({ age21 })} />

      {mode !== 'off' && (
        <>
          <div>
            <Checkbox label="Show the list of who's going to members" checked={value.attendeesPublic} onChange={(attendeesPublic) => set({ attendeesPublic })} />
            <p className="-mt-1 text-xs text-slate-500">Off: only you and ECenter staff can see who's going.</p>
          </div>
          <QuestionsEditor value={value.questions} onChange={(questions) => set({ questions })} error={errorFor('Questions')} />
        </>
      )}
    </div>
  );
}

export function EventIconRow({ icons, max }: { icons: string[]; max?: number }) {
  const shown = (max ? icons.slice(0, max) : icons).flatMap((key) => EVENT_ICON_MAP.get(key) ?? []);
  if (!shown.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What to expect">
      {shown.map(({ key, label, Icon }) => (
        <li key={key} className="chip bg-navy-50 text-navy-700">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

export function GuestVisibilityField({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div>
      <Checkbox label="Hide from guests (people without an account)" checked={!value} onChange={(hidden) => onChange(!hidden)} />
      <p className="-mt-1 text-xs text-slate-500">Guests can browse events without signing in.</p>
    </div>
  );
}

/** Where an event appears: the main feed, or only in chosen groups' feeds. */
export function AudienceField({
  audience,
  onAudience,
  groupIds,
  onGroupIds,
  allGroups,
  error,
}: {
  audience: 'everyone' | 'groups';
  onAudience: (value: 'everyone' | 'groups') => void;
  groupIds: string[];
  onGroupIds: (ids: string[]) => void;
  /** Staff may post to any group; members only to groups they have joined. */
  allGroups?: boolean;
  error?: string | null;
}) {
  const { data, loading } = useApi<{ groups: CommunityGroup[] }>(
    audience === 'groups' ? (allGroups ? '/community/groups' : '/community/groups?mine=1') : null,
  );
  const groups = (data?.groups ?? []).filter((g) => allGroups || g.membership?.status === 'active');
  const toggle = (id: string) => onGroupIds(groupIds.includes(id) ? groupIds.filter((g) => g !== id) : [...groupIds, id]);

  return (
    <fieldset>
      <legend className="label">Who sees this event</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup">
        {(
          [
            ['everyone', 'Everyone (main feed)'],
            ['groups', 'Only specific groups'],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className={`chip min-h-[40px] cursor-pointer border px-3 ${
              audience === value ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-navy-200'
            }`}
          >
            <input type="radio" name="audience" value={value} checked={audience === value} onChange={() => onAudience(value)} className="sr-only" />
            {label}
          </label>
        ))}
      </div>
      {audience === 'groups' && (
        <div className="mt-2 rounded-lg border border-slate-200 p-3">
          {loading && <Spinner label="Loading groups" />}
          {!loading && groups.length === 0 && (
            <p className="text-sm text-slate-500">
              {allGroups ? 'There are no groups yet.' : (
                <>
                  Join a group first. <Link to="/groups" className="font-semibold text-teal-700 hover:underline">Browse groups</Link>
                </>
              )}
            </p>
          )}
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {groups.map((group) => (
              <Checkbox
                key={group.id}
                label={
                  <span>
                    {group.name}
                    {group.privacy === 'private' && <span className="ml-1 text-xs text-slate-500">(private)</span>}
                  </span>
                }
                checked={groupIds.includes(group.id)}
                onChange={() => toggle(group.id)}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">The event appears only in these groups' feeds, not the main feed or to guests.</p>
          {error && <p className="mt-1 text-xs font-semibold text-urgent">{error}</p>}
        </div>
      )}
    </fieldset>
  );
}

/** "See who's going": a modal with the attendee list. */
export function AttendeesButton({ target, id, count }: { target: 'post' | 'event'; id: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [attendees, setAttendees] = useState<Attendee[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setOpen(true);
    setError(null);
    try {
      const response = await api.get<{ attendees: Attendee[] }>(`/community/${target === 'post' ? 'posts' : 'events'}/${id}/attendees`);
      setAttendees(response.attendees);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The list could not be loaded.');
    }
  }

  if (count === 0) return null;
  const guests = attendees ? Math.max(count - attendees.length, 0) : 0;
  return (
    <>
      <button type="button" className="btn-quiet text-sm font-semibold text-teal-700" onClick={show}>
        See who's going
      </button>
      <Modal open={open} title="Who's going" onClose={() => setOpen(false)} width="max-w-md">
        {!attendees && !error && <Spinner label="Loading" />}
        {error && <p className="text-sm text-urgent">{error}</p>}
        {attendees && attendees.length === 0 && guests === 0 && <p className="text-sm text-slate-500">Nobody yet.</p>}
        {attendees && attendees.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {attendees.map((person) => (
              <li key={person.id}>
                <Link to={`/members/${person.id}`} className="flex min-h-[52px] items-center gap-3 py-2 hover:bg-slate-50" onClick={() => setOpen(false)}>
                  <MemberAvatar name={person.name} photoUrl={person.photoUrl} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-navy-800">{person.name}</span>
                    <span className="block text-xs text-slate-500">{accountTypeLabel(person.accountType)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {guests > 0 && <p className="mt-2 text-sm text-slate-500">Plus {guests} {guests === 1 ? 'guest' : 'guests'} without an account.</p>}
      </Modal>
    </>
  );
}

/** Organisers and staff: every RSVP with its answers, plus a spreadsheet download. */
export function ResponsesButton({ target, id, title }: { target: 'post' | 'event'; id: string; title: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const path = `/community/${target === 'post' ? 'posts' : 'events'}/${id}/responses`;
  const { data, loading, error } = useApi<EventResponses>(open ? path : null);

  const answerText = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(', ') : value ?? '');

  async function download() {
    try {
      await downloadCsv(`${path}?format=csv`, `${title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40) || 'event'}-responses.csv`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'The download did not work.');
    }
  }

  return (
    <>
      <button type="button" className="btn-quiet text-sm font-semibold text-teal-700" onClick={() => setOpen(true)}>
        View responses
      </button>
      <Modal
        open={open}
        title="RSVP responses"
        onClose={() => setOpen(false)}
        width="max-w-3xl"
        footer={
          <div className="flex justify-end">
            <button type="button" className="btn-ghost" onClick={download} disabled={!data?.responses.length}>Download spreadsheet</button>
          </div>
        }
      >
        {loading && !data && <Spinner label="Loading" />}
        {error && <p className="text-sm text-urgent">{error}</p>}
        {data && data.responses.length === 0 && <p className="text-sm text-slate-500">No one has RSVP'd yet.</p>}
        {data && data.responses.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {data.responses.map((response, index) => (
              <li key={index} className="py-3">
                <p className="font-semibold text-navy-800">
                  {response.name}
                  <span className="ml-2 text-xs font-normal text-slate-500">{response.kind === 'guest' ? 'Guest' : accountTypeLabel(response.type)}</span>
                  {response.over21 && <span className="ml-2 text-xs font-normal text-amber-700">Confirmed 21+</span>}
                </p>
                {response.email && <p className="text-xs text-slate-500">{response.email}</p>}
                {data.questions.length > 0 && (
                  <dl className="mt-1 space-y-0.5 text-sm">
                    {data.questions.map((question) => (
                      <div key={question.id} className="flex flex-wrap gap-x-1">
                        <dt className="text-slate-500">{question.label}</dt>
                        <dd className="font-medium text-slate-700">{answerText(response.answers[question.id]) || '—'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}

export function Age21Badge() {
  return (
    <span className="chip bg-amber-50 font-bold text-amber-800" title="21+ event">
      21+
    </span>
  );
}
