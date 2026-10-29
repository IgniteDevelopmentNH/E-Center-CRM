import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MemberAvatar, accountTypeLabel } from '../../components/community.tsx';
import { Modal } from '../../components/overlays.tsx';
import { MemberPostEditor, PostCard } from '../../components/posts.tsx';
import { EmptyState, ErrorBlock, Field, LoadingBlock, TextArea, TextInput } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { useApi } from '../../lib/hooks.ts';
import type { CommunityGroup, FeedPost, GroupMember } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

/* ---------------------------------------------------------- shared -- */

function PrivacyChip({ privacy }: { privacy: 'public' | 'private' }) {
  return privacy === 'private' ? (
    <span className="chip bg-slate-100 text-slate-700">
      <span aria-hidden="true">🔒</span> Private
    </span>
  ) : (
    <span className="chip bg-teal-50 text-teal-800">Public</span>
  );
}

/** Join / Request to join / Leave / Cancel request. */
function MembershipButton({ group, onChange }: { group: CommunityGroup; onChange: (group: CommunityGroup) => void }) {
  const { isActiveMember } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!isActiveMember) return null;
  const status = group.membership?.status;

  async function act(path: 'join' | 'leave') {
    if (path === 'leave' && status === 'active' && !window.confirm(`Leave ${group.name}?`)) return;
    setBusy(true);
    try {
      const response = await api.post<{ group: CommunityGroup }>(`/community/groups/${group.id}/${path}`);
      onChange(response.group);
      if (path === 'join') {
        toast.success(response.group.membership?.status === 'pending' ? 'Request sent to the moderators.' : `You joined ${group.name}.`);
      }
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'active') {
    return (
      <button type="button" className="btn-ghost" onClick={() => act('leave')} disabled={busy}>
        ✓ Joined
      </button>
    );
  }
  if (status === 'pending') {
    return (
      <button type="button" className="btn-ghost" onClick={() => act('leave')} disabled={busy} title="Cancel your request">
        Requested · Cancel
      </button>
    );
  }
  return (
    <button type="button" className="btn-primary" onClick={() => act('join')} disabled={busy}>
      {group.privacy === 'private' ? 'Request to join' : 'Join'}
    </button>
  );
}

/** Create or edit a group (name, description, public/private). */
export function GroupEditor({
  group,
  onClose,
  onSaved,
  createPath = '/community/groups',
}: {
  group: CommunityGroup | null;
  onClose: () => void;
  onSaved: (group: CommunityGroup) => void;
  createPath?: string;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [privacy, setPrivacy] = useState<'public' | 'private'>(group?.privacy ?? 'public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const errorFor = (field: string) => (error?.field === field ? error.message : null);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { name, description, privacy };
      const response = group
        ? await api.put<{ group: CommunityGroup }>(`/community/groups/${group.id}`, payload)
        : await api.post<{ group: CommunityGroup }>(createPath, payload);
      onSaved(response.group);
    } catch (caught) {
      setError(caught instanceof ApiError ? { message: caught.message, field: caught.field } : { message: 'Could not save the group.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={group ? 'Group settings' : 'New group'}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => save()} disabled={busy}>
            {busy ? 'Saving...' : group ? 'Save' : 'Create group'}
          </button>
        </div>
      }
    >
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field label="Group name" required error={errorFor('Group name')}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} invalid={!!errorFor('Group name')} />
        </Field>
        <Field label="Description" error={errorFor('Description')}>
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={1000} />
        </Field>
        <fieldset>
          <legend className="label">Who can join</legend>
          <div className="space-y-2">
            {(
              [
                ['public', 'Public', 'Anyone in the community can see posts and join right away.'],
                ['private', 'Private', 'People ask to join, and a moderator approves them. Posts and members are visible to members only.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${privacy === value ? 'border-navy bg-navy-50' : 'border-slate-200'}`}
              >
                <input type="radio" name="privacy" checked={privacy === value} onChange={() => setPrivacy(value)} className="mt-1" />
                <span>
                  <span className="block text-sm font-semibold text-navy-800">{label}</span>
                  <span className="block text-xs text-slate-500">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {group?.privacy === 'private' && privacy === 'public' && group.pendingCount > 0 && (
            <p className="mt-2 text-xs text-amber-700">Making it public lets the {group.pendingCount} people waiting join right away.</p>
          )}
        </fieldset>
        {error && !error.field && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">{error.message}</p>}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ list -- */

export function GroupsPage() {
  const navigate = useNavigate();
  const { data, loading, error, reload, setData } = useApi<{ groups: CommunityGroup[]; canCreate: boolean }>('/community/groups');
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  const replace = (group: CommunityGroup) =>
    setData((current) => (current ? { ...current, groups: current.groups.map((g) => (g.id === group.id ? group : g)) } : current));

  const term = q.trim().toLowerCase();
  const groups = (data?.groups ?? []).filter(
    (g) => !term || g.name.toLowerCase().includes(term) || (g.description ?? '').toLowerCase().includes(term),
  );
  const mine = groups.filter((g) => g.membership?.status === 'active');
  const others = groups.filter((g) => g.membership?.status !== 'active');

  const card = (group: CommunityGroup) => (
    <li key={group.id} className="card flex flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/groups/${group.slug}`} className="min-w-0">
          <h3 className="truncate text-lg font-bold text-navy-800 hover:underline">{group.name}</h3>
        </Link>
        <PrivacyChip privacy={group.privacy} />
      </div>
      {group.description && <p className="mt-1 line-clamp-3 text-sm text-slate-600">{group.description}</p>}
      <p className="mt-2 text-xs text-slate-500">
        {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'} · {group.postCount} {group.postCount === 1 ? 'post' : 'posts'}
        {group.canModerate && group.pendingCount > 0 && (
          <span className="ml-1 font-semibold text-amber-700">· {group.pendingCount} waiting</span>
        )}
      </p>
      <div className="mt-auto flex flex-wrap gap-2 pt-3">
        <Link to={`/groups/${group.slug}`} className="btn-ghost">Open</Link>
        <MembershipButton group={group} onChange={replace} />
      </div>
    </li>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Groups</h1>
          <p className="mt-1 text-sm text-slate-500">Join groups around the topics you care about and see posts shared just with them.</p>
        </div>
        {data?.canCreate && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>New group</button>
        )}
      </div>

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search groups"
        aria-label="Search groups"
        className="input"
      />

      {loading && !data && <LoadingBlock label="Loading groups" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && groups.length === 0 && <EmptyState title="No groups match" message="Try a different search." icon="◎" />}

      {mine.length > 0 && (
        <section aria-labelledby="my-groups">
          <h2 id="my-groups" className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-800">Your groups</h2>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{mine.map(card)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="all-groups">
          <h2 id="all-groups" className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-800">
            {mine.length ? 'More groups' : 'All groups'}
          </h2>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{others.map(card)}</ul>
        </section>
      )}

      {creating && (
        <GroupEditor
          group={null}
          onClose={() => setCreating(false)}
          onSaved={(group) => {
            setCreating(false);
            navigate(`/groups/${group.slug}`);
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- detail -- */

function MembersPanel({ group, onGroupChange }: { group: CommunityGroup; onGroupChange: () => void }) {
  const toast = useToast();
  const { community } = useAuth();
  const { data, loading, error, reload, setData } = useApi<{ members: GroupMember[]; requests: GroupMember[] }>(
    group.canRead ? `/community/groups/${group.id}/members` : null,
  );
  const [busy, setBusy] = useState<string | null>(null);

  async function act(userId: string, method: 'post' | 'put' | 'delete', path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(userId);
    try {
      const url = `/community/groups/${group.id}/${path}`;
      const response =
        method === 'post'
          ? await api.post<{ members: GroupMember[]; requests: GroupMember[] }>(url, body)
          : method === 'put'
            ? await api.put<{ members: GroupMember[]; requests: GroupMember[] }>(url, body)
            : await api.delete<{ members: GroupMember[]; requests: GroupMember[] }>(url);
      setData(() => response);
      onGroupChange();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  if (!group.canRead) {
    return <p className="text-sm text-slate-500">Members are visible once you join.</p>;
  }
  if (loading && !data) return <LoadingBlock label="Loading members" />;
  if (error) return <ErrorBlock message={error} onRetry={reload} />;
  if (!data) return null;

  const row = (member: GroupMember, actions: React.ReactNode) => (
    <li key={member.id} className="flex flex-wrap items-center gap-3 py-2">
      <Link to={`/members/${member.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <MemberAvatar name={member.name} photoUrl={member.photoUrl} size="sm" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-navy-800">
            {member.name}
            {member.role === 'moderator' && <span className="chip ml-2 bg-navy-50 text-navy-700">Moderator</span>}
          </span>
          <span className="block text-xs text-slate-500">{accountTypeLabel(member.accountType)}</span>
        </span>
      </Link>
      {actions}
    </li>
  );

  return (
    <div className="space-y-5">
      {group.canModerate && data.requests.length > 0 && (
        <section aria-labelledby="join-requests">
          <h3 id="join-requests" className="text-sm font-bold text-amber-800">Waiting to join ({data.requests.length})</h3>
          <ul className="divide-y divide-slate-100">
            {data.requests.map((member) =>
              row(
                member,
                <div className="flex gap-1">
                  <button type="button" className="btn-secondary min-h-[36px] px-3 text-xs" disabled={busy === member.id} onClick={() => act(member.id, 'post', `requests/${member.id}/approve`)}>
                    Approve
                  </button>
                  <button type="button" className="btn-quiet min-h-[36px] text-xs" disabled={busy === member.id} onClick={() => act(member.id, 'post', `requests/${member.id}/deny`)}>
                    Decline
                  </button>
                </div>,
              ),
            )}
          </ul>
        </section>
      )}
      <ul className="divide-y divide-slate-100">
        {data.members.map((member) =>
          row(
            member,
            group.canModerate && member.id !== community?.userId ? (
              <div className="flex gap-1">
                <button
                  type="button"
                  className="btn-quiet min-h-[36px] text-xs"
                  disabled={busy === member.id}
                  onClick={() => act(member.id, 'put', `members/${member.id}/role`, { role: member.role === 'moderator' ? 'member' : 'moderator' })}
                >
                  {member.role === 'moderator' ? 'Remove moderator' : 'Make moderator'}
                </button>
                <button
                  type="button"
                  className="btn-quiet min-h-[36px] text-xs text-urgent"
                  disabled={busy === member.id}
                  onClick={() => act(member.id, 'delete', `members/${member.id}`, undefined, `Remove ${member.name} from ${group.name}?`)}
                >
                  Remove
                </button>
              </div>
            ) : null,
          ),
        )}
      </ul>
    </div>
  );
}

function GroupFeed({ group, refreshKey }: { group: CommunityGroup; refreshKey: number }) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      const query = after ? `?cursor=${encodeURIComponent(after)}` : '';
      const response = await api.get<{ posts: FeedPost[]; nextCursor: string | null }>(`/community/groups/${group.id}/posts${query}`);
      setPosts((current) => (after ? [...current, ...response.posts] : response.posts));
      setCursor(response.nextCursor);
    },
    [group.id],
  );

  useEffect(() => {
    if (!group.canRead) return;
    setLoading(true);
    setError(null);
    load(null)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Posts could not be loaded.'))
      .finally(() => setLoading(false));
  }, [load, group.canRead, refreshKey]);

  if (!group.canRead) {
    return (
      <div className="card p-6 text-center">
        <p className="font-semibold text-navy-800">This group is private</p>
        <p className="mt-1 text-sm text-slate-500">Ask to join to see its posts. A moderator will review your request.</p>
      </div>
    );
  }
  if (loading) return <LoadingBlock label="Loading posts" />;
  if (error) return <ErrorBlock message={error} />;
  const patch = (id: string) => (change: Partial<FeedPost>) =>
    setPosts((current) => current.map((p) => (p.id === id ? { ...p, ...change } : p)));
  return (
    <div className="space-y-4">
      {posts.length === 0 && <EmptyState title="No posts yet" message="Posts shared with this group will appear here." icon="▤" />}
      {posts.map((post) => (
        <PostCard key={post.id} post={post} onChange={patch(post.id)} />
      ))}
      {cursor && (
        <div className="flex justify-center">
          <button type="button" className="btn-ghost" onClick={() => void load(cursor)}>Load more posts</button>
        </div>
      )}
    </div>
  );
}

export function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { community } = useAuth();
  const { data, loading, error, reload, setData } = useApi<{ group: CommunityGroup; moderators: GroupMember[] }>(
    id ? `/community/groups/${id}` : null,
  );
  const [tab, setTab] = useState<'posts' | 'members'>('posts');
  const [editing, setEditing] = useState(false);
  const [composing, setComposing] = useState(false);
  const [feedKey, setFeedKey] = useState(0);

  if (loading && !data) return <LoadingBlock label="Loading group" />;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <ErrorBlock message={error ?? 'That group is not available.'} onRetry={reload} />
        <Link to="/groups" className="btn-ghost">All groups</Link>
      </div>
    );
  }
  const { group, moderators } = data;
  const setGroup = (next: CommunityGroup) => setData((current) => (current ? { ...current, group: next } : current));
  const canPostHere = group.membership?.status === 'active' && !!community && community.postPermission !== 'none';

  async function archive() {
    if (!window.confirm(`Archive ${group.name}? It disappears for everyone; ECenter staff can restore it.`)) return;
    try {
      await api.delete(`/community/groups/${group.id}`);
      toast.success('Group archived.');
      navigate('/groups', { replace: true });
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/groups" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-teal-700 hover:underline">
        <span aria-hidden="true">←</span>&nbsp;Groups
      </Link>

      <header className="card overflow-hidden">
        <div className="h-16 bg-gradient-to-r from-navy to-teal-700" aria-hidden="true" />
        <div className="space-y-3 p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-navy-800">{group.name}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                <PrivacyChip privacy={group.privacy} />
                {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <MembershipButton group={group} onChange={setGroup} />
              {group.canModerate && (
                <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>Settings</button>
              )}
            </div>
          </div>
          {group.description && <p className="whitespace-pre-line text-[15px] text-slate-700">{group.description}</p>}
          {moderators.length > 0 && (
            <p className="text-xs text-slate-500">
              Moderated by{' '}
              {moderators.map((m, i) => (
                <span key={m.id}>
                  {i > 0 && ', '}
                  <Link to={`/members/${m.id}`} className="font-semibold text-navy-700 hover:underline">{m.name}</Link>
                </span>
              ))}
            </p>
          )}
        </div>
      </header>

      {canPostHere && (
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="card flex min-h-[52px] w-full items-center px-4 text-left text-sm text-slate-500 hover:bg-slate-50"
        >
          Share something with {group.name}...
        </button>
      )}

      <div className="flex gap-1 rounded-lg bg-slate-100 p-1" role="tablist">
        {(['posts', 'members'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`min-h-[40px] flex-1 rounded-md text-sm font-semibold ${tab === value ? 'bg-white text-navy-800 shadow-card' : 'text-slate-600'}`}
          >
            {value === 'posts' ? 'Posts' : `Members${group.canModerate && group.pendingCount ? ` (${group.pendingCount} waiting)` : ''}`}
          </button>
        ))}
      </div>

      {tab === 'posts' ? (
        <GroupFeed group={group} refreshKey={feedKey} />
      ) : (
        <div className="card p-4 sm:p-6">
          <MembersPanel group={group} onGroupChange={reload} />
        </div>
      )}

      {group.canModerate && !group.isDefault && (
        <div className="text-right">
          <button type="button" className="btn-quiet text-urgent" onClick={archive}>Archive group</button>
        </div>
      )}

      {editing && (
        <GroupEditor
          group={group}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setGroup(saved);
            if (saved.slug !== id) navigate(`/groups/${saved.slug}`, { replace: true });
          }}
        />
      )}
      {composing && community && (
        <MemberPostEditor
          post={null}
          needsApproval={community.postPermission === 'approval'}
          defaultAudience="groups"
          defaultGroupIds={[group.id]}
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            setFeedKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
