import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import type { Attendee, CommunityGroup } from '../lib/types.ts';
import { MemberAvatar, accountTypeLabel } from './community.tsx';
import { Modal } from './overlays.tsx';
import { Checkbox, Spinner } from './ui.tsx';

/**
 * Options shared by member posts, staff posts and CRM events: 21+, a public
 * attendee list, hiding from guests, and (for posts) sharing only with chosen
 * groups instead of the main feed.
 */

export function EventOptionFields({
  rsvpEnabled,
  age21,
  onAge21,
  attendeesPublic,
  onAttendeesPublic,
}: {
  rsvpEnabled: boolean;
  age21: boolean;
  onAge21: (value: boolean) => void;
  attendeesPublic: boolean;
  onAttendeesPublic: (value: boolean) => void;
}) {
  return (
    <>
      <div>
        <Checkbox label={'21+ event: people confirm "I\'m over 21" when they RSVP'} checked={age21} onChange={onAge21} />
      </div>
      {rsvpEnabled && (
        <div>
          <Checkbox label="Show the list of who's going to members" checked={attendeesPublic} onChange={onAttendeesPublic} />
          <p className="-mt-1 text-xs text-slate-500">Off: only you and ECenter staff can see who's going.</p>
        </div>
      )}
    </>
  );
}

export function GuestVisibilityField({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div>
      <Checkbox label="Hide from guests (people without an account)" checked={!value} onChange={(hidden) => onChange(!hidden)} />
      <p className="-mt-1 text-xs text-slate-500">Guests can browse the main feed and events without signing in.</p>
    </div>
  );
}

/** Where a post appears: the main feed, or only in chosen groups' feeds. */
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
      <legend className="label">Who sees this post</legend>
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
          <p className="mt-1 text-xs text-slate-500">The post appears only in these groups' feeds, not the main feed or to guests.</p>
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
  return (
    <>
      <button type="button" className="btn-quiet text-sm font-semibold text-teal-700" onClick={show}>
        See who's going
      </button>
      <Modal open={open} title="Who's going" onClose={() => setOpen(false)} width="max-w-md">
        {!attendees && !error && <Spinner label="Loading" />}
        {error && <p className="text-sm text-urgent">{error}</p>}
        {attendees && attendees.length === 0 && <p className="text-sm text-slate-500">Nobody yet.</p>}
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
