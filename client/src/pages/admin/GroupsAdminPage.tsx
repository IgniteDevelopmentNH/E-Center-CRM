import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MemberAvatar, accountTypeLabel } from '../../components/community.tsx';
import { Modal } from '../../components/overlays.tsx';
import { Chip, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { useApi, useDebounced } from '../../lib/hooks.ts';
import type { CommunityGroup, PublicMember } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';
import { GroupEditor } from '../community/GroupsPage.tsx';

/** Adds a moderator by searching the community directory. */
function AddModerator({ group, onClose, onDone }: { group: CommunityGroup; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const debounced = useDebounced(q.trim(), 300);
  const { data, loading } = useApi<{ members: PublicMember[] }>(
    debounced ? `/community/members?q=${encodeURIComponent(debounced)}&limit=10` : null,
  );

  async function choose(member: PublicMember) {
    setBusy(member.id);
    try {
      await api.put(`/community/groups/${group.id}/members/${member.id}/role`, { role: 'moderator' });
      toast.success(`${member.fullName} now moderates ${group.name}.`);
      onDone();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open title={`Add a moderator to ${group.name}`} onClose={onClose} width="max-w-md">
      <p className="mb-3 text-sm text-slate-600">
        Moderators can edit the group, make it private, approve join requests and manage members. They are added to the group if they are not in it yet.
      </p>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members by name" aria-label="Search members" className="input" autoFocus />
      {loading && <p className="mt-3 text-sm text-slate-500">Searching...</p>}
      {data && data.members.length === 0 && <p className="mt-3 text-sm text-slate-500">No one matches that.</p>}
      <ul className="mt-2 divide-y divide-slate-100">
        {data?.members.map((member) => (
          <li key={member.id} className="flex items-center gap-3 py-2">
            <MemberAvatar name={member.fullName} photoUrl={member.photoUrl} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-navy-800">{member.fullName}</span>
              <span className="block text-xs text-slate-500">{accountTypeLabel(member.accountType)}</span>
            </span>
            <button type="button" className="btn-secondary min-h-[36px] px-3 text-xs" disabled={!!busy} onClick={() => choose(member)}>
              {busy === member.id ? 'Adding...' : 'Make moderator'}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Admin > Groups: every group with its moderators; create, edit, archive and restore. */
export function GroupsAdminPage() {
  const { canEdit } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ groups: CommunityGroup[] }>('/admin/groups');
  const [editing, setEditing] = useState<CommunityGroup | 'new' | null>(null);
  const [addingTo, setAddingTo] = useState<CommunityGroup | null>(null);

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast.success(success);
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Groups</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Topic groups in the community. Give members "Can create groups" in Members to let them start and moderate their own.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>+ New group</button>
        )}
      </header>

      {loading && !data && <LoadingBlock label="Loading groups" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.groups.length === 0 && <EmptyState title="No groups yet" message="Create the first group." icon="⊕" />}

      <div className="card overflow-hidden">
        <ul className="divide-y divide-slate-100">
          {data?.groups.map((group) => (
            <li key={group.id} className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${group.archived ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {group.archived ? (
                    <span className="font-semibold text-navy-800">{group.name}</span>
                  ) : (
                    <Link to={`/groups/${group.slug}`} className="font-semibold text-navy-800 hover:underline">{group.name}</Link>
                  )}
                  <Chip tone={group.privacy === 'private' ? 'slate' : 'teal'}>{group.privacy === 'private' ? 'Private' : 'Public'}</Chip>
                  {group.isDefault && <Chip tone="navy">Default</Chip>}
                  {group.archived && <Chip tone="amber">Archived</Chip>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'} · {group.postCount} {group.postCount === 1 ? 'post' : 'posts'}
                  {group.pendingCount > 0 && ` · ${group.pendingCount} waiting to join`}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Moderators: {group.moderators?.length ? group.moderators.map((m) => m.name).join(', ') : 'ECenter staff only'}
                </p>
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-1">
                  {group.archived ? (
                    <button type="button" className="btn-quiet" onClick={() => run(() => api.post(`/admin/groups/${group.id}/restore`), 'Group restored.')}>
                      Restore
                    </button>
                  ) : (
                    <>
                      <button type="button" className="btn-quiet" onClick={() => setEditing(group)}>Edit</button>
                      <button type="button" className="btn-quiet" onClick={() => setAddingTo(group)}>Add moderator</button>
                      <button
                        type="button"
                        className="btn-quiet text-urgent"
                        onClick={() => {
                          if (window.confirm(`Archive ${group.name}? Members will no longer see it.`)) {
                            void run(() => api.delete(`/community/groups/${group.id}`), 'Group archived.');
                          }
                        }}
                      >
                        Archive
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {editing && (
        <GroupEditor
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {addingTo && (
        <AddModerator
          group={addingTo}
          onClose={() => setAddingTo(null)}
          onDone={() => {
            setAddingTo(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
