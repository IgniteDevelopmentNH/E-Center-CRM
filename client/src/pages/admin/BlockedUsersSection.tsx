import { useState } from 'react';
import { ConfirmDialog } from '../../components/overlays.tsx';
import { ErrorBlock, LoadingBlock, SectionHeader } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import type { BlockedEmail } from '../../lib/types.ts';
import { useToast } from '../../state/ToastContext.tsx';

/**
 * Settings > Blocked users. Removing a member from the community blocks their
 * email from signing up again; unblocking lets them back in and restores
 * their account.
 */
export function BlockedUsersSection({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ blocked: BlockedEmail[] }>('/admin/blocked-emails');
  const [unblocking, setUnblocking] = useState<BlockedEmail | null>(null);
  const [busy, setBusy] = useState(false);

  async function unblock() {
    if (!unblocking) return;
    setBusy(true);
    try {
      const result = await api.delete<{ reactivated: boolean }>(`/admin/blocked-emails/${unblocking.id}`);
      toast.success(result.reactivated ? 'Unblocked and their account restored.' : 'Unblocked. They can sign up again.');
      setUnblocking(null);
      reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-5">
      <SectionHeader title="Blocked users" count={data?.blocked.length} />
      <p className="mb-3 text-sm text-slate-500">
        When you remove someone from the community, their email can't be used to sign up again. Unblock to undo it.
      </p>
      {loading && !data && <LoadingBlock label="Loading" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.blocked.length === 0 && <p className="text-sm text-slate-500">No one is blocked.</p>}
      {data && data.blocked.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {data.blocked.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-navy-800">{entry.name ?? entry.email}</p>
                {entry.name && <p className="truncate text-sm text-slate-600">{entry.email}</p>}
                <p className="text-xs text-slate-500">
                  Blocked {formatDateTime(entry.createdAt)}
                  {entry.blockedByName ? ` by ${entry.blockedByName}` : ''}
                  {entry.reason && <span className="block">“{entry.reason}”</span>}
                </p>
              </div>
              {canEdit && (
                <button type="button" className="btn-ghost" onClick={() => setUnblocking(entry)}>
                  Unblock
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!unblocking}
        title="Unblock this email?"
        message={`${unblocking?.email ?? ''} will be able to sign up again${unblocking?.userId ? ', and their removed account will be restored' : ''}.`}
        confirmLabel="Unblock"
        busy={busy}
        onConfirm={unblock}
        onCancel={() => setUnblocking(null)}
      />
    </section>
  );
}
